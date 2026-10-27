package browserjobs_test

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func source(t *testing.T) []byte {
	t.Helper()
	left, right := make([]float32, 1024), make([]float32, 1024)
	for i := range left {
		left[i] = float32(.15*math.Sin(float64(i)*.3) + .05*math.Sin(float64(i)*.8))
		right[i] = left[i] * .8
	}
	left[0], right[0] = 1.25, -.0
	wav, err := audio.EncodeWAV(left, right, 8000, 32)
	if err != nil {
		t.Fatal(err)
	}
	return wav
}

func run(t *testing.T, request browserjobs.Request, wav, reference []byte) *browserjobs.Result {
	t.Helper()
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	result, err := browserjobs.Execute(context.Background(), raw, wav, reference, nil)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestClosedLocalRequestAndHostileCDR(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{}`, `{"operation":"features","operation":"render"}`, `{"Operation":"features"}`, `{"operation":"features","params":"{}"}`, `{"operation":"features","unknown":1}`, `{"operation":"render","params":null}`, `{"operation":"render"} {}`} {
		if _, err := browserjobs.DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("untrusted metadata accepted: %s", raw)
		}
	}
	wav := source(t)
	for _, input := range [][]byte{[]byte("MZ executable"), append(append([]byte{}, wav...), []byte("%PDF- payload")...), wav[:len(wav)-1]} {
		if _, err := browserjobs.Execute(context.Background(), []byte(`{"operation":"render"}`), input, nil, nil); err == nil {
			t.Fatal("hostile/truncated audio survived shared local CDR")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := browserjobs.Execute(ctx, []byte(`{"operation":"features"}`), wav, nil, nil); err == nil {
		t.Fatal("canceled native context processed audio")
	}
}

// nativeRender posts wav and form fields to the native HTTP render endpoint.
func nativeRender(t *testing.T, wav []byte, fields [][2]string) []byte {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "source.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(wav); err != nil {
		t.Fatal(err)
	}
	for _, field := range fields {
		if err := form.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	native := server.New(server.Config{Workers: 1})
	defer native.Close()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", &body)
	request.Host = "127.0.0.1:8080"
	request.Header.Set("Content-Type", form.FormDataContentType())
	recorder := httptest.NewRecorder()
	native.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("native render status %d", recorder.Code)
	}
	return recorder.Body.Bytes()
}

func TestLocalRenderMatchesNativeHTTPAndSourceIdentity(t *testing.T) {
	wav := source(t)
	params := dsp.DefaultParams()
	params.InputGainDB = -3
	params.Compressor.Enabled = false
	params.Saturation.Enabled = false
	params.Bands[2].GainDB = 1.25
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	local := run(t, browserjobs.Request{Operation: "render", Params: string(encoded), BitDepth: 24}, wav, nil)
	if !bytes.Equal(local.Audio, nativeRender(t, wav, [][2]string{{"params", string(encoded)}, {"bitDepth", "24"}})) {
		t.Fatal("local/native rendered WAV differs")
	}
	canonical := run(t, browserjobs.Request{Operation: "render", Params: `{"bypass":true}`, BitDepth: 32}, wav, nil)
	if !bytes.Equal(canonical.Audio, wav) {
		t.Fatal("local import changed finite float headroom/source bits")
	}
	var metadata struct{ SourceIdentity mastering.SourceIdentity }
	if err := json.Unmarshal(canonical.Metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	decoded, err := audio.DecodeAndDisarm("source.wav", wav)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := mastering.SourceIdentityContext(context.Background(), decoded)
	if err != nil || metadata.SourceIdentity != identity {
		t.Fatal("local import identity differs from native canonical identity")
	}
}

// Converted exports must also match byte for byte: the delivery limiter and
// TPDF dither are deterministic (fixed-seed generator per render), so both
// dither none and TPDF are compared.
func TestLocalConvertedRenderMatchesNativeHTTP(t *testing.T) {
	const rate = 48000
	left, right := make([]float32, rate/2), make([]float32, rate/2)
	for i := range left {
		at := float64(i) / rate
		left[i] = float32(0.6*math.Sin(2*math.Pi*997*at) + 0.3*math.Sin(2*math.Pi*15000*at))
		right[i] = float32(0.6*math.Sin(2*math.Pi*1499*at) - 0.3*math.Sin(2*math.Pi*19000*at))
	}
	wav, err := audio.EncodeWAV(left, right, rate, 24)
	if err != nil {
		t.Fatal(err)
	}
	params := dsp.DefaultParams()
	params.InputGainDB = 8
	params.Limiter.Enabled = true
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		sampleRate, bitDepth int
		dither               string
	}{{44100, 24, "none"}, {96000, 24, ""}, {44100, 16, "tpdf"}} {
		local := run(t, browserjobs.Request{Operation: "render", Params: string(encoded), BitDepth: c.bitDepth, SampleRate: c.sampleRate, Dither: c.dither}, wav, nil)
		fields := [][2]string{{"params", string(encoded)}, {"bitDepth", strconv.Itoa(c.bitDepth)}, {"sampleRate", strconv.Itoa(c.sampleRate)}}
		if c.dither != "" {
			fields = append(fields, [2]string{"dither", c.dither})
		}
		native := nativeRender(t, wav, fields)
		if !bytes.Equal(local.Audio, native) {
			t.Fatalf("%+v: local/native converted WAV differs", c)
		}
		decoded, err := audio.DecodeAndDisarm("render.wav", native)
		if err != nil || decoded.SampleRate != c.sampleRate {
			t.Fatalf("%+v: decoded %v at %d Hz", c, err, decoded.SampleRate)
		}
		// Repeating the render reproduces the same TPDF sequence.
		if again := run(t, browserjobs.Request{Operation: "render", Params: string(encoded), BitDepth: c.bitDepth, SampleRate: c.sampleRate, Dither: c.dither}, wav, nil); !bytes.Equal(again.Audio, local.Audio) {
			t.Fatalf("%+v: repeated local render differs", c)
		}
	}
}
func TestLocalAnalysisReferenceAndCompilerReuseNativeContracts(t *testing.T) {
	wav := source(t)
	features := run(t, browserjobs.Request{Operation: "features"}, wav, nil)
	if !bytes.Contains(features.Metadata, []byte(`"kind":"analyze_features"`)) {
		t.Fatal("wrong feature DTO")
	}
	deep := run(t, browserjobs.Request{Operation: "deep", ScriptVersion: "2.0", Profile: "modern_pop_polish"}, wav, nil)
	var proposal struct{ ScriptV2 mastering.ScriptV2 }
	if err := json.Unmarshal(deep.Metadata, &proposal); err != nil {
		t.Fatal(err)
	}
	script, err := json.Marshal(proposal.ScriptV2)
	if err != nil {
		t.Fatal(err)
	}
	compiled := run(t, browserjobs.Request{Operation: "compile", Script: string(script), DeviceRate: 48000}, nil, nil)
	if !bytes.Contains(compiled.Metadata, []byte(`"sourceVerified":false`)) || !bytes.Contains(compiled.Metadata, []byte(`"deviceRate":48000`)) {
		t.Fatal("compiler changed unverified numeric contract")
	}
	_ = run(t, browserjobs.Request{Operation: "render", Script: string(script), BitDepth: 32}, wav, nil)
	other := append([]byte{}, wav...)
	other[len(other)-4] ^= 1
	if _, err := browserjobs.Execute(context.Background(), []byte(`{"operation":"render","script":`+string(mustJSON(t, string(script)))+`}`), other, nil, nil); err == nil {
		t.Fatal("automation rendered against different canonical PCM")
	}
	reference := run(t, browserjobs.Request{Operation: "reference", Options: `{"amount":0,"protectBelowHz":120}`}, wav, wav)
	if !bytes.Contains(reference.Metadata, []byte(`"sourceSpectrum":"baseline_rendered"`)) || !bytes.Contains(reference.Metadata, []byte(`"kind":"analyze_reference"`)) {
		t.Fatal("reference DTO changed measured baseline contract")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestWriteBrowserOracle is an opt-in binary oracle for actual browser worker E2E.
func TestWriteBrowserOracle(t *testing.T) {
	directory := os.Getenv("AURIALIS_BROWSER_ORACLE_DIR")
	if directory == "" {
		t.Skip("set AURIALIS_BROWSER_ORACLE_DIR for native versus actual browser PCM")
	}
	files := fixtureRoot(t, directory)
	raw, err := files.ReadFile("request.json")
	if err != nil {
		t.Fatal(err)
	}
	source, err := files.ReadFile("source.wav")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := files.ReadFile("reference.wav")
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	result, err := browserjobs.Execute(context.Background(), raw, source, reference, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := files.WriteFile("native.wav", result.Audio, 0600); err != nil {
		t.Fatal(err)
	}
	if err := files.WriteFile("native.json", result.Metadata, 0600); err != nil {
		t.Fatal(err)
	}
}

// TestGeneratedStaticPolicyMatchesNative checks the exact emitted inline CSP bytes.
func TestGeneratedStaticPolicyMatchesNative(t *testing.T) {
	directory := os.Getenv("AURIALIS_BROWSER_STATIC_DIR")
	if directory == "" {
		t.Skip("set AURIALIS_BROWSER_STATIC_DIR after preparing the static assets")
	}
	files := fixtureRoot(t, directory)
	data, err := files.ReadFile("asset-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var policy struct{ CSP string }
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	assets, err := files.OpenRoot("assets")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := assets.Close(); err != nil {
			t.Error(err)
		}
	})
	native := server.New(server.Config{Workers: 1, StaticFS: assets.FS()})
	defer native.Close()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	request.Host = "127.0.0.1:8080"
	recorder := httptest.NewRecorder()
	native.Handler().ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Security-Policy") != policy.CSP {
		t.Fatal("static Worker CSP differs from native exact inline-script policy")
	}
}

// fixtureRoot confines opt-in process-owned oracle paths, never audio filenames.
func fixtureRoot(t *testing.T, directory string) *os.Root {
	t.Helper()
	files, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return files
}

// V1-13 Round E 2 S-a2: measure=render skips the source measurement a client
// already cached. The render and its afterMetrics are unchanged, beforeMetrics
// is null, and the native server answers the same. It is JSON-only, and a
// bypass render still measures (its after is the source).
func TestRenderMeasureOnlySkipsTheSourceMeasurement(t *testing.T) {
	wav := source(t)
	params := dsp.DefaultParams()
	params.InputGainDB = -3
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	decode := func(raw []byte) map[string]json.RawMessage {
		var body map[string]json.RawMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	full := decode(run(t, browserjobs.Request{Operation: "render", Params: string(encoded), Format: "json"}, wav, nil).Metadata)
	only := decode(run(t, browserjobs.Request{Operation: "render", Params: string(encoded), Format: "json", Measure: "render"}, wav, nil).Metadata)
	if string(only["beforeMetrics"]) != "null" || string(full["beforeMetrics"]) == "null" || !bytes.Equal(only["afterMetrics"], full["afterMetrics"]) {
		t.Fatalf("measure=render: before %s, after %s vs %s", only["beforeMetrics"], only["afterMetrics"], full["afterMetrics"])
	}
	native := decode(nativeRender(t, wav, [][2]string{{"params", string(encoded)}, {"format", "json"}, {"measure", "render"}}))
	if string(native["beforeMetrics"]) != "null" || !bytes.Equal(native["afterMetrics"], full["afterMetrics"]) {
		t.Fatalf("native measure=render: before %s, after %s", native["beforeMetrics"], native["afterMetrics"])
	}
	bypass := decode(run(t, browserjobs.Request{Operation: "render", Params: `{"bypass":true}`, Format: "json", Measure: "render"}, wav, nil).Metadata)
	if string(bypass["beforeMetrics"]) == "null" {
		t.Fatal("a bypass render skipped its only measurement")
	}
	for _, request := range []browserjobs.Request{{Operation: "render", Params: string(encoded), Measure: "render"}, {Operation: "render", Params: string(encoded), Format: "json", Measure: "source"}} {
		raw, _ := json.Marshal(request)
		if _, err := browserjobs.Execute(context.Background(), raw, wav, nil, nil); err == nil {
			t.Fatalf("accepted %+v", request)
		}
	}
}
