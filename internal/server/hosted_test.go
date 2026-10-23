package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func hostedConfig() *server.HostedConfig {
	return &server.HostedConfig{Origins: []string{"https://aurialis.yosefgamble.com", "https://aurialis.yosef.app"}, GatewaySecret: strings.Repeat("a", 64)}
}

func authenticateTestRequest(request *http.Request, owner string) {
	request.Host = "aurialis.yosefgamble.com"
	request.Header.Set("X-Aurialis-Gateway", strings.Repeat("a", 64))
	request.Header.Set("X-Aurialis-Session", owner)
	request.Header.Set("Origin", "https://"+request.Host)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
}

func TestHostedGatewayFailsClosedAndPreservesLocalDefault(t *testing.T) {
	cfg := hostedConfig()
	for _, origin := range []string{"http://aurialis.yosefgamble.com", "https://aurialis.yosefgamble.com/", "https://aurialis.yosefgamble.com?", "https://aurialis.yosefgamble.com:443", "https://user@aurialis.yosefgamble.com", "https://AURIALIS.yosefgamble.com"} {
		invalid := *cfg
		invalid.Origins = []string{origin}
		if invalid.Validate() == nil {
			t.Fatalf("invalid fixed origin accepted: %s", origin)
		}
	}
	local := server.New(server.Config{Workers: 1})
	defer local.Close()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
	authenticateTestRequest(request, strings.Repeat("b", 64))
	recorder := httptest.NewRecorder()
	local.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatal("gateway header enabled hosted mode on default local server")
	}
	broken := server.New(server.Config{Workers: 1, Hosted: &server.HostedConfig{Origins: cfg.Origins}})
	defer broken.Close()
	recorder = httptest.NewRecorder()
	broken.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatal("incomplete hosted configuration failed open")
	}
	hosted := server.New(server.Config{Workers: 1, Hosted: cfg})
	defer hosted.Close()
	for _, test := range []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"missing gateway", func(r *http.Request) { r.Header.Del("X-Aurialis-Gateway") }},
		{"wrong gateway", func(r *http.Request) { r.Header.Set("X-Aurialis-Gateway", strings.Repeat("c", 64)) }},
		{"duplicate gateway", func(r *http.Request) { r.Header.Add("X-Aurialis-Gateway", strings.Repeat("a", 64)) }},
		{"foreign host", func(r *http.Request) { r.Host = "evil.example" }},
		{"host alias suffix", func(r *http.Request) { r.Host += ".evil.example" }},
		{"foreign origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }},
		{"duplicate origin", func(r *http.Request) { r.Header.Add("Origin", "https://aurialis.yosefgamble.com") }},
		{"cross site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }},
		{"forwarded host", func(r *http.Request) { r.Header.Set("X-Forwarded-Host", r.Host) }},
		{"forwarded proto", func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "https") }},
		{"forwarded chain", func(r *http.Request) { r.Header.Set("Forwarded", "host="+r.Host) }},
		{"forwarded ip", func(r *http.Request) { r.Header.Set("X-Forwarded-For", "127.0.0.1") }},
		{"invalid session", func(r *http.Request) { r.Header.Set("X-Aurialis-Session", "not-authenticated") }},
		{"duplicate session", func(r *http.Request) { r.Header.Add("X-Aurialis-Session", strings.Repeat("b", 64)) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
			authenticateTestRequest(r, strings.Repeat("b", 64))
			test.mutate(r)
			rec := httptest.NewRecorder()
			hosted.Handler().ServeHTTP(rec, r)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("request accepted: %d", rec.Code)
			}
		})
	}
	// Mutating the caller's origin slice after construction must not alter policy.
	cfg.Origins[0] = "https://evil.example"
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
	authenticateTestRequest(r, "")
	rec := httptest.NewRecorder()
	hosted.Handler().ServeHTTP(rec, r)
	var health struct {
		DeploymentMode string `json:"deploymentMode"`
		MaxUploadBytes int64  `json:"maxUploadBytes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil || rec.Code != http.StatusOK || health.DeploymentMode != "hosted" || health.MaxUploadBytes != server.HostedMaxUploadBytes {
		t.Fatalf("invalid hosted capability bound: %d %v", rec.Code, err)
	}
	if rec.Header().Get("Cross-Origin-Opener-Policy") != "same-origin" || rec.Header().Get("Cross-Origin-Embedder-Policy") != "require-corp" {
		t.Fatal("hosted mode removed WASM isolation")
	}
}

func TestHostedJobsIsolateEveryStatusCancelAndDownloadAlias(t *testing.T) {
	hosted := server.New(server.Config{Workers: 1, Hosted: hostedConfig()})
	defer hosted.Close()
	owner, foreign := strings.Repeat("b", 64), strings.Repeat("c", 64)
	r := newMultipartRequest(t, http.MethodPost, "/api/separate", "source.wav", buildTestWAV(t, 8000, .01), map[string]string{"stems": "2"})
	authenticateTestRequest(r, owner)
	rec := httptest.NewRecorder()
	hosted.Handler().ServeHTTP(rec, r)
	var job jobs.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil || rec.Code != http.StatusAccepted {
		t.Fatalf("hosted native admission: %d %v", rec.Code, err)
	}
	for _, prefix := range []string{"/jobs/", "/api/jobs/"} {
		for _, suffix := range []string{"", "/status", "/result", "/stems/vocals", "/stems/vocals.wav"} {
			for _, id := range []string{job.ID, "job-unknown"} {
				r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, prefix+id+suffix, nil)
				authenticateTestRequest(r, foreign)
				rec := httptest.NewRecorder()
				hosted.Handler().ServeHTTP(rec, r)
				if rec.Code != http.StatusNotFound {
					t.Fatalf("foreign/unknown job distinguishable at%s: %d", r.URL.Path, rec.Code)
				}
			}
		}
		cancel := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, prefix+job.ID, nil)
		authenticateTestRequest(cancel, foreign)
		rec := httptest.NewRecorder()
		hosted.Handler().ServeHTTP(rec, cancel)
		if rec.Code != http.StatusNotFound {
			t.Fatal("foreign owner could cancel job")
		}
	}
	poll := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+job.ID+"?wait=1", nil)
	authenticateTestRequest(poll, owner)
	rec = httptest.NewRecorder()
	hosted.Handler().ServeHTTP(rec, poll)
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil || rec.Code != http.StatusOK || job.Status != jobs.StatusDone || len(job.Stems) != 2 {
		t.Fatalf("foreign access changed actual processing: %d %v", rec.Code, err)
	}
	for _, path := range []string{"/jobs/" + job.ID + "/stems/vocals", "/api/jobs/" + job.ID + "/stems/vocals.wav"} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
		authenticateTestRequest(r, owner)
		rec := httptest.NewRecorder()
		hosted.Handler().ServeHTTP(rec, r)
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Body.String(), "RIFF") {
			t.Fatalf("owner cannot download actual canonical audio: %d", rec.Code)
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		r := httptest.NewRequestWithContext(context.Background(), method, "/api/jobs/"+job.ID, nil)
		authenticateTestRequest(r, owner)
		r.Header.Del("Origin")
		rec := httptest.NewRecorder()
		hosted.Handler().ServeHTTP(rec, r)
		if rec.Code != http.StatusForbidden {
			t.Fatal("state-changing hosted request accepted without Origin")
		}
	}
	missing := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+job.ID, nil)
	authenticateTestRequest(missing, "")
	rec = httptest.NewRecorder()
	hosted.Handler().ServeHTTP(rec, missing)
	if rec.Code != http.StatusForbidden {
		t.Fatal("job operation accepted without authenticated session")
	}
}
