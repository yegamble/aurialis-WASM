package server_test

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// Exports can convert to a delivery rate and choose dither. Conversion happens
// after mastering, then the ceiling and dither are applied once at the new rate.
func TestExportSampleRateAndDither(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate, frames = 44100, 44100
	l, r := make([]float32, frames), make([]float32, frames)
	for i := range l {
		l[i] = float32(0.5 * math.Sin(2*math.Pi*997*float64(i)/rate))
		r[i] = l[i] * 0.8
	}
	wav, err := audio.EncodeWAV(l, r, rate, 32)
	if err != nil {
		t.Fatal(err)
	}
	params := dsp.DefaultParams()
	params.InputGainDB = 6
	params.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	params.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 100, TruePeak: true}
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	post := func(fields map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, fields))
		return recorder
	}
	decode := func(recorder *httptest.ResponseRecorder) *audio.Buffer {
		t.Helper()
		if recorder.Code != http.StatusOK {
			t.Fatalf("render %d: %s", recorder.Code, recorder.Body.String())
		}
		out, err := audio.DecodeAndDisarm("render.wav", recorder.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	source := decode(post(map[string]string{"params": string(encoded), "bitDepth": "24"}))
	sourceLevel := dsp.MeasureStereo(source.Left, source.Right, rate)
	for _, to := range []int{48000, 88200, 96000} {
		out := decode(post(map[string]string{"params": string(encoded), "bitDepth": "24", "sampleRate": strconv.Itoa(to)}))
		if out.SampleRate != to || out.Frames != (frames*to+rate-1)/rate {
			t.Fatalf("%d Hz export layout %d Hz × %d frames", to, out.SampleRate, out.Frames)
		}
		m := dsp.MeasureStereo(out.Left, out.Right, float64(to))
		if math.Abs(m.IntegratedLUFS-sourceLevel.IntegratedLUFS) > 0.05 || m.SamplePeakDBFS > -1 {
			t.Fatalf("%d Hz: %.2f LUFS (source %.2f), sample peak %.2f dBFS", to, m.IntegratedLUFS, sourceLevel.IntegratedLUFS, m.SamplePeakDBFS)
		}
	}
	same := post(map[string]string{"params": string(encoded), "bitDepth": "24", "sampleRate": "44100"})
	if !bytes.Equal(same.Body.Bytes(), post(map[string]string{"params": string(encoded), "bitDepth": "24"}).Body.Bytes()) {
		t.Fatal("converting to the source rate must equal the unconverted export")
	}
	dithered := decode(post(map[string]string{"params": string(encoded), "bitDepth": "16", "sampleRate": "48000"}))
	plain := decode(post(map[string]string{"params": string(encoded), "bitDepth": "16", "sampleRate": "48000", "dither": "none"}))
	differs := false
	for i := range plain.Left {
		if plain.Left[i] != dithered.Left[i] {
			differs = true
			break
		}
	}
	if !differs {
		t.Fatal("dither none produced the dithered export")
	}
	for name, fields := range map[string]map[string]string{
		"rate":       {"sampleRate": "22050"},
		"rate text":  {"sampleRate": "fast"},
		"dither":     {"dither": "shaped"},
		"duplicated": {"sampleRate": "48000", "dither": "none,none"},
	} {
		if code := post(fields).Code; code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
}

// Export conversion fields belong to the render endpoint only.
func TestExportFieldsRejectedOutsideRender(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	l := make([]float32, 8000)
	wav, err := audio.EncodeWAV(l, l, 8000, 16)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/api/analyze/deep", "/api/separate", "/api/analyze/features"} {
		for _, fields := range []map[string]string{{"sampleRate": "48000"}, {"dither": "none"}, {"sampleRate": "22050", "dither": "bogus"}} {
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, target, "source.wav", wav, fields))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_multipart"`) {
				t.Errorf("%s %v: status %d %s, want 400 invalid_multipart", target, fields, recorder.Code, recorder.Body.String())
			}
		}
	}
}
