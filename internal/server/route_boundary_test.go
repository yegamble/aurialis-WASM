package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestUnknownNativeRoutesReturn404(t *testing.T) {
	srv := server.New(server.Config{StaticFS: fstest.MapFS{"index.html": {Data: []byte("home")}, "master/placeholder.html": {Data: []byte("master")}}})
	defer srv.Close()
	for _, path := range []string{"/does-not-exist", "/does/not/exist", "/api/unknown", "/unknown.js", "/master/x/extra", "/jobs/unknown"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
			req.Host = "127.0.0.1:3000"
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != 404 {
				t.Fatalf("got %d, want 404", rec.Code)
			}
		})
	}
	for _, path := range []string{"/", "/library", "/albums", "/tools", "/master/a", "/split/a", "/reference/a", "/release-check/a", "/albums/a"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
			req.Host = "127.0.0.1:3000"
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != 200 {
				t.Fatalf("got %d, want 200", rec.Code)
			}
		})
	}
}
