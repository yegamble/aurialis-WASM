package server_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// TestExportBudgetCalibration times a 1,048,576-frame export through the real
// render handler on this machine, extrapolates linearly to the two QA-2
// acceptance shapes, and requires each export budget to be at least twice the
// extrapolated cost. CI runs it in its own step so the timings are recorded.
func TestExportBudgetCalibration(t *testing.T) {
	if raceEnabled {
		t.Skip("timing calibration is meaningless under the race detector")
	}
	if testing.Short() {
		t.Skip("timing calibration skipped in -short mode")
	}
	const (
		sampleFrames = 1 << 20
		sourceRate   = 48000
	)
	cases := []struct {
		name         string
		outputRate   int
		acceptFrames int
	}{
		{"16,777,216 frames 48 kHz to 96 kHz", 96000, 1 << 24},
		{"33,554,432 frames 48 kHz to 44.1 kHz", 44100, 1 << 25},
	}
	srv := server.New(server.Config{Workers: 1})
	t.Cleanup(srv.Close)
	wav := buildTestWAV(t, sourceRate, float64(sampleFrames)/sourceRate)
	for _, c := range cases {
		req := newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav,
			map[string]string{"sampleRate": strconv.Itoa(c.outputRate)})
		w := httptest.NewRecorder()
		start := time.Now()
		srv.Handler().ServeHTTP(w, req)
		elapsed := time.Since(start)
		if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "audio/wav" {
			t.Fatalf("%s: status %d: %.300s", c.name, w.Code, w.Body.String())
		}
		scale := float64(c.acceptFrames) / sampleFrames
		extrapolated := time.Duration(float64(elapsed) * scale)
		budget := server.ExportBudget(c.acceptFrames, sourceRate, c.outputRate)
		t.Logf("%s: %d-frame render took %v (%.2f µs/frame); extrapolated %v; budget %v (%.2fx)",
			c.name, sampleFrames, elapsed.Round(time.Millisecond),
			float64(elapsed.Microseconds())/sampleFrames, extrapolated.Round(time.Second),
			budget, float64(budget)/float64(extrapolated))
		if budget < 2*extrapolated {
			t.Errorf("%s: budget %v is under twice the extrapolated cost %v", c.name, budget, extrapolated)
		}
	}
}
