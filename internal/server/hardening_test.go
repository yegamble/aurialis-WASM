package server_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestExactLocalOriginsAndListenerPort(t *testing.T) {
	srv := server.New(server.Config{ListenAddress: "127.0.0.1:8080"})
	defer srv.Close()
	cases := []struct {
		name, host, origin, site string
		want                     int
	}{
		{"same origin", "127.0.0.1:8080", "http://127.0.0.1:8080", "same-origin", 200},
		{"null origin", "127.0.0.1:8080", "null", "", 403},
		{"other port", "127.0.0.1:8080", "http://127.0.0.1:8081", "", 403},
		{"file origin", "127.0.0.1:8080", "file:///evil", "", 403},
		{"other scheme", "127.0.0.1:8080", "https://127.0.0.1:8080", "", 403},
		{"userinfo", "127.0.0.1:8080", "http://user@127.0.0.1:8080", "", 403},
		{"origin path", "127.0.0.1:8080", "http://127.0.0.1:8080/path", "", 403},
		{"same site", "127.0.0.1:8080", "", "same-site", 403},
		{"wrong host port", "127.0.0.1:9999", "", "", 403},
		{"wildcard host", "0.0.0.0:8080", "", "", 403},
		{"empty host", "", "", "", 403},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
			r.Host = test.host
			r.Header.Set("Origin", test.origin)
			r.Header.Set("Sec-Fetch-Site", test.site)
			w := httptest.NewRecorder()
			srv.Handler().ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatalf("status=%d want=%d", w.Code, test.want)
			}
			if w.Header().Get("Cross-Origin-Embedder-Policy") != "require-corp" {
				t.Fatal("missing security headers")
			}
		})
	}
}

func TestMultipartTraversalDuplicatesAndChunkedLimit(t *testing.T) {
	srv := server.New(server.Config{MaxUploadBytes: 64 * 1024})
	defer srv.Close()
	wav := buildTestWAV(t, 16000, 0.1)
	for _, name := range []string{"../song.wav", "folder/song.wav", `folder\song.wav`} {
		r := newMultipartRequest(t, http.MethodPost, "/api/master/render", name, wav, nil)
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("traversal %q accepted: %d", name, w.Code)
		}
	}
	r := newMultipartRequest(t, http.MethodPost, "/api/master/render", "huge.wav", bytes.Repeat([]byte{0}, 70*1024), nil)
	r.ContentLength = -1
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("chunked overflow status=%d", w.Code)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for range 2 {
		part, err := writer.CreateFormFile("file", "song.wav")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(wav); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", &body)
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w = httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("duplicate file status=%d", w.Code)
	}
}

func TestStreamingUploadNeverSpillsRawFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	srv := server.New(server.Config{})
	defer srv.Close()
	r := newMultipartRequest(t, http.MethodPost, "/api/master/render", "large.wav", bytes.Repeat([]byte{0}, 17*1024*1024), nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("invalid WAV status=%d", w.Code)
	}
	if r.MultipartForm != nil && len(r.MultipartForm.File) != 0 {
		t.Fatal("raw multipart file retained")
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatal("raw upload spilled to disk")
	}
}

type blockingBody struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingBody) Read(_ []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	<-b.release
	return 0, io.EOF
}
func (*blockingBody) Close() error { return nil }

func TestAudioAdmissionRejectsBeforeReadingThirdBody(t *testing.T) {
	srv := server.New(server.Config{})
	defer srv.Close()
	var group sync.WaitGroup
	bodies := make([]*blockingBody, 2)
	for i := range bodies {
		b := &blockingBody{started: make(chan struct{}), release: make(chan struct{})}
		bodies[i] = b
		group.Go(func() {
			r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", b)
			r.Host = "127.0.0.1:8080"
			r.Header.Set("Content-Type", "multipart/form-data; boundary=boundary")
			srv.Handler().ServeHTTP(httptest.NewRecorder(), r)
		})
	}
	defer func() {
		for _, b := range bodies {
			close(b.release)
		}
		group.Wait()
	}()
	for _, b := range bodies {
		select {
		case <-b.started:
		case <-time.After(time.Second):
			t.Fatal("upload did not start")
		}
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", nil)
	r.Host = "127.0.0.1:8080"
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 429 {
		t.Fatalf("third request status=%d", w.Code)
	}
}

func TestCSPHashesTrustedBootstrap(t *testing.T) {
	inline := `self.__next_f.push([1,"test"])`
	assets := fstest.MapFS{"index.html": {Data: []byte(`<script>` + inline + `</script>`)}}
	srv := server.New(server.Config{StaticFS: assets})
	defer srv.Close()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	r.Host = "127.0.0.1:8080"
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	csp := w.Header().Get("Content-Security-Policy")
	hash := sha256.Sum256([]byte(inline))
	if !strings.Contains(csp, "'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
		t.Fatal("bootstrap hash missing")
	}
	scriptPolicy := strings.Split(strings.Split(csp, "script-src ")[1], ";")[0]
	if strings.Contains(scriptPolicy, "'unsafe-inline'") {
		t.Fatal("arbitrary inline scripts allowed")
	}
}

func TestStrictRenderParameters(t *testing.T) {
	srv := server.New(server.Config{})
	defer srv.Close()
	wav := buildTestWAV(t, 16000, 0.1)
	for _, params := range []string{`{"unknown":true}`, `null`, `{"compressor":null}`, `{} {}`, `{"inputGainDb":1e300}`} {
		r := newMultipartRequest(t, http.MethodPost, "/api/master/render", "song.wav", wav, map[string]string{"params": params})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("params %s status=%d", params, w.Code)
		}
	}
}
