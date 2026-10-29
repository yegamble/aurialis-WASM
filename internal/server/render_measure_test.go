package server_test

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestRenderMeasurementSelection(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	left := make([]float32, 3200)
	for i := range left {
		left[i] = float32(0.2 * math.Sin(2*math.Pi*220*float64(i)/8000))
	}
	wav, err := audio.EncodeWAV(left, left, 8000, 16)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, format, accept, params, measure string
		wantSource                            bool
	}{
		{"default", "json", "", `{}`, "", true},
		{"render-format", "json", "", `{}`, "render", false},
		{"render-accept", "", "application/json", `{}`, "render", false},
		{"bypass-keeps-source", "json", "", `{"bypass":true}`, "render", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			request := newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"params": c.params, "measure": c.measure, "format": c.format})
			request.Header.Set("Accept", c.accept)
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, request)
			var result struct {
				Before json.RawMessage `json:"beforeMetrics"`
				After  json.RawMessage `json:"afterMetrics"`
			}
			if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &result) != nil {
				t.Fatalf("render %d: %.200s", recorder.Code, recorder.Body.String())
			}
			if source := len(result.Before) > 0 && string(result.Before) != "null"; source != c.wantSource {
				t.Errorf("source metrics present %v, want %v: %s", source, c.wantSource, result.Before)
			}
			if len(result.After) == 0 || string(result.After) == "null" {
				t.Fatal("render measurement missing")
			}
		})
	}
	for _, c := range []struct {
		name, target string
		fields       map[string]string
	}{
		{"non-json", "/api/master/render", map[string]string{"measure": "render"}},
		{"unknown-mode", "/api/master/render", map[string]string{"measure": "source", "format": "json"}},
		{"features", "/api/analyze/features", map[string]string{"measure": "render"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, c.target, "source.wav", wav, c.fields))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_multipart"`) {
				t.Fatalf("status %d: %.200s, want 400 invalid_multipart", recorder.Code, recorder.Body.String())
			}
		})
	}
	t.Run("duplicate", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, repeatedFieldRequest(t, "/api/master/render", wav, "measure", []string{"render", "render"}))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_multipart"`) {
			t.Fatalf("status %d: %.200s, want 400 invalid_multipart", recorder.Code, recorder.Body.String())
		}
	})
}

func TestMonitorModeRejectsExportsAndOtherOperations(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav, err := audio.EncodeWAV(make([]float32, 128), make([]float32, 128), 8000, 32)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		target string
		fields map[string]string
	}{
		{"/api/master/render", map[string]string{"monitorMode": "mono"}},
		{"/api/master/render", map[string]string{"monitorMode": ""}},
		{"/api/master/render", map[string]string{"monitorMode": "side", "format": "wav"}},
		{"/api/master/render", map[string]string{"monitorMode": "middle", "format": "json"}},
		{"/api/analyze/features", map[string]string{"monitorMode": "mono"}},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, newMultipartRequest(t, http.MethodPost, c.target, "source.wav", wav, c.fields))
		if rec.Code != 400 {
			t.Fatalf("accepted %v: %d", c, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, repeatedFieldRequest(t, "/api/master/render", wav, "monitorMode", []string{"mono", "side"}))
	if rec.Code != 400 {
		t.Fatal("duplicate mode accepted")
	}
}
