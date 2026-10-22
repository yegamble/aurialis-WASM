package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestMeasuredFeatureAPIProducesSourceBoundNeutralResults(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, 0.25)
	for _, route := range []string{"/api/analyze/features", "/analyze/features"} {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, route, "source.wav", wav, nil))
		if recorder.Code != http.StatusAccepted {
			t.Fatalf("%s returned%d: %s", route, recorder.Code, recorder.Body.String())
		}
		var submitted jobs.Job
		if err := json.Unmarshal(recorder.Body.Bytes(), &submitted); err != nil {
			t.Fatal(err)
		}
		poll := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+submitted.ID+"?wait=1", nil)
		poll.Host = "127.0.0.1:8080"
		recorder = httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, poll)
		var completed jobs.Job
		if err := json.Unmarshal(recorder.Body.Bytes(), &completed); err != nil {
			t.Fatal(err)
		}
		if recorder.Code != http.StatusOK || completed.Status != jobs.StatusDone || completed.Kind != jobs.KindAnalyzeFeatures || completed.Features == nil {
			t.Fatalf("feature job failed: %s", recorder.Body.String())
		}
		features := completed.Features
		if features.Version != "1.0" || len(features.Source.PCMHash) != 64 || features.Source.SampleRate != 8000 || features.Source.Frames != 2000 || len(features.Sections) != 1 || features.Sections[0].Name != "Section 1" || features.Sections[0].EndFrame != 2000 {
			t.Fatal("unexpected feature source/section contract", features)
		}
		if features.Bands[4].Valid || completed.Script != nil || len(completed.Stems) != 0 {
			t.Fatal("analysis fabricated high-band availability or processing artifacts")
		}
		cancel := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/jobs/"+submitted.ID, nil)
		cancel.Host = "127.0.0.1:8080"
		recorder = httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, cancel)
		if recorder.Code != http.StatusOK {
			t.Fatal("analysis cancellation route failed")
		}
	}
}

func TestMeasuredFeatureAPIRejectsUnsupportedOptionsAndInvalidAudio(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, 0.25)
	for _, test := range []struct {
		route  string
		fields map[string]string
		data   []byte
	}{
		{route: "/api/analyze/features?profile=warm", data: wav},
		{route: "/api/analyze/features", fields: map[string]string{"profile": "Warm Analog"}, data: wav},
		{route: "/api/analyze/features", fields: map[string]string{"script": "{}"}, data: wav},
		{route: "/api/analyze/features", data: []byte("MZ hostile executable")},
	} {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, test.route, "source.wav", test.data, test.fields))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("unsupported feature request returned%d: %s", recorder.Code, recorder.Body.String())
		}
	}
}

type failedFeatureDelivery struct{ *httptest.ResponseRecorder }

func (writer failedFeatureDelivery) Write(data []byte) (int, error) {
	_, _ = writer.ResponseRecorder.Write(data)
	return 0, errors.New("submission transport closed")
}

func TestMeasuredFeatureSubmissionDeliveryFailureCancelsAdmittedJob(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	recorder := httptest.NewRecorder()
	writer := failedFeatureDelivery{ResponseRecorder: recorder}
	srv.Handler().ServeHTTP(writer, newMultipartRequest(t, http.MethodPost, "/api/analyze/features", "source.wav", buildTestWAV(t, 8000, 0.25), nil))
	var submitted jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &submitted); err != nil || submitted.ID == "" {
		t.Fatal("failed to capture admitted identity", err)
	}
	poll := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+submitted.ID, nil)
	poll.Host = "127.0.0.1:8080"
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, poll)
	var job jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusCanceled || job.Features != nil {
		t.Fatalf("failed delivery orphaned analysis: %+v", job)
	}
}
