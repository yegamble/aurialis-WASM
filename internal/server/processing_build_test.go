package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/build"
)

func TestProcessingBuildResponseHeader(t *testing.T) {
	for _, fingerprint := range []string{strings.Repeat("a", 64), ""} {
		handler := processingBuildHeader(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), fingerprint)
		for _, route := range []string{"/api/health", "/api/jobs/missing", "/api/master/render", "/api/analyze/features", "/api/unknown"} {
			request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, route, nil)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if actual := recorder.Header().Get("X-Aurialis-Processing-Build"); actual != fingerprint {
				t.Fatalf("%s: response identity %q; expected %q", route, actual, fingerprint)
			}
			if recorder.Code != http.StatusNoContent {
				t.Fatal("Identity middleware changed the underlying status", recorder.Code)
			}
		}
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if values := recorder.Header().Values("X-Aurialis-Processing-Build"); len(values) != 0 {
			t.Fatal("Static response unexpectedly gained an API processing identity", values)
		}
	}
}

func TestProcessingBuildHeaderIsWiredToAPIResponses(t *testing.T) {
	srv := New(Config{Workers: 1})
	defer srv.Close()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/health", nil)
	request.Host = "127.0.0.1:8080"
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, request)
	values := recorder.Header().Values("X-Aurialis-Processing-Build")
	if len(values) != 1 || values[0] != build.QualifiedFingerprint() {
		t.Fatal("Actual native API did not expose its captured linked identity", values)
	}
}
