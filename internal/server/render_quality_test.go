package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestNativeProposalAcceptsOnlyExplicitKnownQuality(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	for _, fields := range []map[string]string{{"scriptVersion": "2.0", "renderQuality": "unknown"}, {"renderQuality": "oversampled"}} {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/analyze/deep", "source.wav", wav, fields))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("accepted invalid quality: %d", recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/analyze/deep", "source.wav", wav, map[string]string{"scriptVersion": "2.0", "renderQuality": "oversampled"}))
	if recorder.Code != http.StatusAccepted {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
	var submitted jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+submitted.ID, nil)
		request.Host = "127.0.0.1:8080"
		recorder = httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, request)
		var result jobs.Job
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status == jobs.StatusDone {
			if result.ScriptV2 == nil || result.ScriptV2.ChainParams.AlgorithmVersion != 3 || result.Prediction == nil {
				t.Fatal("native proposal lost quality")
			}
			return
		}
		if result.Status == jobs.StatusFailed {
			t.Fatal(recorder.Body.String())
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("proposal did not finish")
}
