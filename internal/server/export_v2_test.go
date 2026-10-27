package server_test

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// intersampleWAV holds a quarter-rate tone sampled 45 degrees off its peaks,
// so every sample sits 3 dB below the reconstructed waveform.
func intersampleWAV(t *testing.T, sampleRate, frames int) []byte {
	t.Helper()
	l, r := make([]float32, frames), make([]float32, frames)
	for i := range l {
		tm := float64(i) / float64(sampleRate)
		s := float32(0.6*math.Sin(math.Pi/2*float64(i)+math.Pi/4) + 0.2*math.Sin(2*math.Pi*1000*tm))
		l[i], r[i] = s, s
	}
	wav, err := audio.EncodeWAV(l, r, sampleRate, 32)
	if err != nil {
		t.Fatal(err)
	}
	return wav
}

// Exports send algorithmVersion 2 with limiter.truePeak, as plain parameters
// and as applied scripts. The true-peak limiter must hold the reconstructed
// ceiling where the v1 sample-peak limiter cannot, at the source length and rate.
func TestExportRenderWithTruePeakAlgorithm(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate, frames, ceiling = 44100, 22050, -1.0
	wav := intersampleWAV(t, rate, frames)
	params := dsp.DefaultParams()
	params.InputGainDB = 12
	params.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: ceiling, TargetLUFS: -14, ReleaseMS: 100}
	render := func(fields map[string]string) dsp.Metrics {
		t.Helper()
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, fields))
		if recorder.Code != http.StatusOK {
			t.Fatalf("render %d: %s", recorder.Code, recorder.Body.String())
		}
		out, err := audio.DecodeAndDisarm("render.wav", recorder.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if out.SampleRate != rate || len(out.Left) != frames {
			t.Fatalf("export layout %d Hz × %d frames", out.SampleRate, len(out.Left))
		}
		return dsp.MeasureStereo(out.Left[rate/10:], out.Right[rate/10:], rate)
	}
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if legacy := render(map[string]string{"params": encode(params), "bitDepth": "32"}); legacy.TruePeakDBTP < ceiling+1 {
		t.Fatalf("fixture does not expose v1 intersample overs: %.2f dBTP", legacy.TruePeakDBTP)
	}
	params.AlgorithmVersion, params.Limiter.TruePeak = dsp.TruePeakAlgorithmVersion, true
	if got := render(map[string]string{"params": encode(params), "bitDepth": "32"}); got.TruePeakDBTP > ceiling {
		t.Fatalf("v2 parameter export %.2f dBTP above %.1f", got.TruePeakDBTP, ceiling)
	}
	script := apiScript(t, wav)
	script.ChainParams = params
	if got := render(map[string]string{"script": encodedScript(t, script), "bitDepth": "32"}); got.TruePeakDBTP > ceiling {
		t.Fatalf("v2 script export %.2f dBTP above %.1f", got.TruePeakDBTP, ceiling)
	}
}

// V1-09 Round E: the deprecated profile= render has no algorithm in the
// request, so it renders through the true-peak export limiter and delivers
// at most -1 dBTP like every current export.
func TestDeprecatedProfileRenderHoldsTheTruePeakCeiling(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate, frames = 44100, 22050
	wav := intersampleWAV(t, rate, frames)
	for _, profile := range []string{"metal_wall", "modern_pop_polish", "Punchy Commercial"} {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"profile": profile, "bitDepth": "32"}))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", profile, recorder.Code, recorder.Body.String())
		}
		out, err := audio.DecodeAndDisarm("render.wav", recorder.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if got := dsp.MeasureStereo(out.Left, out.Right, rate); got.TruePeakDBTP > -1 {
			t.Fatalf("%s: %.2f dBTP above -1", profile, got.TruePeakDBTP)
		}
	}
}
