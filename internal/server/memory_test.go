package server

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
)

type countedMemoryBody struct{ reads int }

func (b *countedMemoryBody) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (*countedMemoryBody) Close() error               { return nil }
func TestProcessMemoryRejectsUploadBeforeReadingBody(t *testing.T) {
	s := New(Config{Workers: 1})
	defer s.Close()
	held, err := s.jobs.ReserveMemory(jobs.MaxProcessMemoryBytes - s.uploadMemoryBytes() + 1)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	body := &countedMemoryBody{}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", nil)
	r.Host = "127.0.0.1:8080"
	r.Body = body
	r.ContentLength = -1
	r.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "memory_capacity") || body.reads != 0 {
		t.Fatalf("code%d reads%d body%s", rec.Code, body.reads, rec.Body.String())
	}
}
func TestRequestMemoryReleasesAfterInvalidUploadAndCanceledRender(t *testing.T) {
	s := New(Config{Workers: 1})
	defer s.Close()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/master/render", strings.NewReader("bad multipart"))
	r.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	if rec.Code != 400 {
		t.Fatalf("invalid multipart got%d", rec.Code)
	}
	lease, err := s.jobs.ReserveMemory(jobs.MaxProcessMemoryBytes)
	if err != nil {
		t.Fatal("failed upload leaked memory", err)
	}
	lease.Release()
	ctx, cancel := context.WithCancel(context.Background())
	s.exportStarted = func(context.Context) { cancel() }
	r = memoryRenderRequest(ctx, t)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	lease, err = s.jobs.ReserveMemory(jobs.MaxProcessMemoryBytes)
	if err != nil {
		t.Fatal("canceled render leaked memory", err)
	}
	lease.Release()
}
func TestRenderReservationTracksConversionGeometry(t *testing.T) {
	s := New(Config{Workers: 1})
	defer s.Close()
	called := false
	s.exportStarted = func(ctx context.Context) {
		called = true
		if requestMemory(httptest.NewRequestWithContext(ctx, http.MethodGet, "/", nil)) == nil {
			t.Error("render lost request ownership")
		}
		lease, err := s.jobs.ReserveMemory(jobs.MaxProcessMemoryBytes)
		if err == nil {
			lease.Release()
			t.Error("render was not accounted")
		}
	}
	r := memoryRenderRequest(context.Background(), t)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	if !called || rec.Code != 200 {
		t.Fatalf("render did not complete: %d %s", rec.Code, rec.Body.String())
	}
	buf := &audio.Buffer{SampleRate: 48000, Frames: 16, Left: make([]float32, 16, 32), Right: make([]float32, 16, 32)}
	if got, want := renderMemoryBytes(buf, 96000), int64(64*1024*1024+32*8+16*16+32*24); got != want {
		t.Fatalf("converted reservation%d want%d", got, want)
	}
}
func memoryRenderRequest(ctx context.Context, t *testing.T) *http.Request {
	t.Helper()
	wav, err := audio.EncodeWAV(make([]float32, 16), make([]float32, 16), 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "source.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(wav); err != nil {
		t.Fatal(err)
	}
	if err = writer.WriteField("params", `{"bypass":true}`); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/master/render", &body)
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Content-Type", writer.FormDataContentType())
	return r
}
