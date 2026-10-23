package browserjobs_test

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "source.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(wav); err != nil {
		t.Fatal(err)
	}
	for _, field := range []struct{ key, value string }{{"params", string(encoded)}, {"bitDepth", "24"}} {
		if err := form.WriteField(field.key, field.value); err != nil {
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
	if recorder.Code != http.StatusOK || !bytes.Equal(local.Audio, recorder.Body.Bytes()) {
		t.Fatalf("local/native rendered WAV differs: native status%d", recorder.Code)
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
