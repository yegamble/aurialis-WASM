package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

type referencePart struct {
	name, filename string
	data           []byte
}

func referenceUpload(t *testing.T, parts []referencePart) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		if part.filename != "" {
			file, err := writer.CreateFormFile(part.name, part.filename)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = file.Write(part.data); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := writer.WriteField(part.name, string(part.data)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/analyze/reference", &body)
	request.Host = "127.0.0.1:8080"
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestReferenceAPIReconstructsBothSourcesAndReturnsBoundResult(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, referenceUpload(t, []referencePart{{"source", "source.wav", wav}, {"reference", "reference.wav", wav}, {name: "options", data: []byte(`{"amount":0,"protectBelowHz":120}`)}}))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("reference submit%d: %s", recorder.Code, recorder.Body.String())
	}
	var job jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	poll := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+job.ID+"?wait=1", nil)
	poll.Host = "127.0.0.1:8080"
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, poll)
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusDone || job.Kind != jobs.KindAnalyzeReference || job.ReferenceProposal == nil {
		t.Fatalf("missing reference result: %s", recorder.Body.String())
	}
	if job.ReferenceProposal.Source != job.ReferenceProposal.Reference || job.ReferenceProposal.Source.Frames != 2000 || len(job.ReferenceProposal.Source.PCMHash) != 64 {
		t.Fatal("source identity/frames not bound")
	}
	cancel := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/jobs/"+job.ID, nil)
	cancel.Host = "127.0.0.1:8080"
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, cancel)
	if strings.Contains(recorder.Body.String(), "referenceProposal") {
		t.Fatal("canceled result retained")
	}
}

func TestReferenceAPIRejectsUntrustedPartsAndAmbiguousOptions(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	base := []referencePart{{"source", "source.wav", wav}, {"reference", "reference.wav", wav}}
	for _, extra := range []referencePart{{name: "options", data: []byte(`{"amount":1,"amount":0,"protectBelowHz":120}`)}, {name: "options", data: []byte(`{"amount":1,"protectBelowHz":80}`)}, {name: "options", data: []byte(`{"amount":1,"protectBelowHz":120,"includeWidth":"true"}`)}, {name: "params", data: []byte(`{"unknown":true}`)}, {"source", "duplicate.wav", wav}, {name: "profile", data: []byte("warm")}} {
		parts := append(append([]referencePart{}, base...), extra)
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, referenceUpload(t, parts))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("ambiguous reference request%d: %s", recorder.Code, recorder.Body.String())
		}
	}
	for _, name := range []string{"source", "reference"} {
		parts := append([]referencePart{}, base...)
		for i := range parts {
			if parts[i].name == name {
				parts[i].data = []byte("MZ executable payload")
			}
		}
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, referenceUpload(t, parts))
		if recorder.Code != http.StatusBadRequest {
			t.Fatal("untrusted source/reference accepted")
		}
	}
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, referenceUpload(t, base[:1]))
	if recorder.Code != http.StatusBadRequest {
		t.Fatal("missing reference accepted")
	}
}
