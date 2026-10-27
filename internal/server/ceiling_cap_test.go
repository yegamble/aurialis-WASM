package server_test

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// V1-09 chair ruling: no route accepts a limiter ceiling above -1 dBTP.
func TestMasterRoutesRejectCeilingAboveMinusOne(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate = 48000
	l, r := make([]float32, rate/2), make([]float32, rate/2)
	for i := range l {
		l[i] = float32(0.25 * math.Sin(2*math.Pi*440*float64(i)/rate))
		r[i] = l[i]
	}
	wav, err := audio.EncodeWAV(l, r, rate, 16)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/master/render", "/master/render"} {
		for _, ceiling := range []string{"-0.5", "0"} {
			fields := map[string]string{"bitDepth": "24", "params": `{"limiter":{"enabled":true,"ceilingDbtp":` + ceiling + `,"targetLufs":-14,"releaseMs":80,"truePeak":true}}`}
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, path, "source.wav", wav, fields))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "limiter.ceilingDbtp") {
				t.Fatalf("%s ceiling %s: %d %s", path, ceiling, recorder.Code, recorder.Body.String())
			}
		}
	}
}

// QA (V1-09 Round E): a ceiling sent as a string names the field and type
// instead of a generic JSON error.
func TestMasterRenderNamesMistypedCeiling(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate = 48000
	l, r := make([]float32, rate/4), make([]float32, rate/4)
	wav, err := audio.EncodeWAV(l, r, rate, 16)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"params": `{"limiter":{"ceilingDbtp":"-0.5"}}`}))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "limiter.ceilingDbtp must be a number") || !strings.Contains(recorder.Body.String(), "invalid_params") {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
}
