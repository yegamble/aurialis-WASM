package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func buildTestWAV(t *testing.T, sampleRate int, durationSec float64) []byte {
	t.Helper()
	n := int(float64(sampleRate) * durationSec)
	l := make([]float32, n)
	r := make([]float32, n)
	for i := 0; i < n; i++ {
		tm := float64(i) / float64(sampleRate)
		s := float32(0.35*math.Sin(2.0*math.Pi*110.0*tm) + 0.25*math.Sin(2.0*math.Pi*1000.0*tm))
		l[i] = s
		r[i] = s
	}
	wav, err := audio.EncodeWAV(l, r, sampleRate, 16)
	if err != nil {
		t.Fatalf("EncodeWAV failed: %v", err)
	}
	return wav
}

func newMultipartRequest(t *testing.T, method, target, filename string, fileData []byte, fields map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if fileData != nil {
		fw, err := mw.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("CreateFormFile failed: %v", err)
		}
		if _, err := fw.Write(fileData); err != nil {
			t.Fatalf("Write fileData failed: %v", err)
		}
	}
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("WriteField(%s) failed: %v", k, err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart Close failed: %v", err)
	}
	req := httptest.NewRequestWithContext(context.Background(), method, target, &body)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestHealthAndSecurityHeadersAndCSRFGuards(t *testing.T) {
	staticFS := fstest.MapFS{
		"index.html":              {Data: []byte("<html><body>Aurialis</body></html>")},
		"wasm/aurialis.wasm":      {Data: []byte("\x00asm\x01\x00\x00\x00")},
		"master/placeholder.html": {Data: []byte("<html><body>Master Shell</body></html>")},
	}
	srv := server.New(server.Config{
		MaxUploadBytes: 1024 * 1024,
		Workers:        2,
		StaticFS:       staticFS,
	})
	defer srv.Close()

	// 1. GET /health
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
	req.Host = "127.0.0.1:3000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	res := rec.Result()
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /health status = %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
		t.Errorf("COOP = %q, want same-origin", got)
	}
	if got := res.Header.Get("Cross-Origin-Embedder-Policy"); got != "require-corp" {
		t.Errorf("COEP = %q, want require-corp", got)
	}
	if got := res.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := res.Header.Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q, want DENY", got)
	}

	// 2. DNS Rebinding Host check -> 403
	evilHostReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/health", nil)
	evilHostReq.Host = "attacker.dnsrebind.example:8080"
	evilHostRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(evilHostRec, evilHostReq)
	evilHostRes := evilHostRec.Result()
	defer func() { _ = evilHostRes.Body.Close() }()
	if evilHostRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for foreign Host header, got %d", evilHostRes.StatusCode)
	}

	// 3. Drive-by CSRF Origin check -> 403
	csrfReq := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/separate", nil)
	csrfReq.Host = "127.0.0.1:8080"
	csrfReq.Header.Set("Origin", "https://malicious.site")
	csrfRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(csrfRec, csrfReq)
	csrfRes := csrfRec.Result()
	defer func() { _ = csrfRes.Body.Close() }()
	if csrfRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-origin POST, got %d", csrfRes.StatusCode)
	}

	// 4. Static WASM MIME type check
	wasmReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/wasm/aurialis.wasm", nil)
	wasmReq.Host = "localhost:3000"
	wasmRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(wasmRec, wasmReq)
	wasmRes := wasmRec.Result()
	defer func() { _ = wasmRes.Body.Close() }()
	if wasmRes.Header.Get("Content-Type") != "application/wasm" {
		t.Fatalf("expected application/wasm, got %q", wasmRes.Header.Get("Content-Type"))
	}
}

func TestSeparateAndDeepAnalyzeAndMasterRenderEndToEnd(t *testing.T) {
	srv := server.New(server.Config{
		MaxUploadBytes: 64 * 1024, // 64 KB limit to test 413 easily
		Workers:        2,
	})
	defer srv.Close()

	wavBytes := buildTestWAV(t, 16000, 0.25)

	// 1. Submit Smart Split (4 stems)
	sepReq := newMultipartRequest(t, http.MethodPost, "/separate", "song.wav", wavBytes, map[string]string{
		"stems": "4",
		"model": "htdemucs",
	})
	sepRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(sepRec, sepReq)
	sepRes := sepRec.Result()
	defer func() { _ = sepRes.Body.Close() }()
	if sepRes.StatusCode != http.StatusAccepted {
		bodyBytes, _ := io.ReadAll(sepRes.Body)
		t.Fatalf("POST /separate status = %d: %s", sepRes.StatusCode, string(bodyBytes))
	}

	var sepJob map[string]any
	if err := json.NewDecoder(sepRes.Body).Decode(&sepJob); err != nil {
		t.Fatalf("Decode job JSON failed: %v", err)
	}
	jobID, _ := sepJob["jobId"].(string)
	jobIDSnake, _ := sepJob["job_id"].(string)
	if jobID == "" || jobID != jobIDSnake {
		t.Fatalf("expected matching jobId and job_id, got %q vs %q", jobID, jobIDSnake)
	}

	// Poll /jobs/{id}/status until done
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		pollReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/jobs/"+jobID+"/status", nil)
		pollReq.Host = "127.0.0.1:8080"
		pollRec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(pollRec, pollReq)
		pollRes := pollRec.Result()
		var state map[string]any
		_ = json.NewDecoder(pollRes.Body).Decode(&state)
		_ = pollRes.Body.Close()
		if state["status"] == "done" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Download vocals stem
	stemReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/jobs/"+jobID+"/stems/vocals", nil)
	stemReq.Host = "127.0.0.1:8080"
	stemRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(stemRec, stemReq)
	stemRes := stemRec.Result()
	defer func() { _ = stemRes.Body.Close() }()
	stemWAV, _ := io.ReadAll(stemRes.Body)
	if stemRes.StatusCode != http.StatusOK || len(stemWAV) <= 44 || string(stemWAV[0:4]) != "RIFF" {
		t.Fatalf("stem download failed: status=%d len=%d", stemRes.StatusCode, len(stemWAV))
	}

	// 2. Submit Deep Analysis
	deepReq := newMultipartRequest(t, http.MethodPost, "/analyze/deep", "song.wav", wavBytes, map[string]string{
		"profile": "Punchy Commercial",
	})
	deepRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(deepRec, deepReq)
	deepRes := deepRec.Result()
	defer func() { _ = deepRes.Body.Close() }()
	if deepRes.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /analyze/deep status = %d", deepRes.StatusCode)
	}

	// 3. Synchronous /api/master/render
	renderReq := newMultipartRequest(t, http.MethodPost, "/api/master/render", "song.wav", wavBytes, map[string]string{
		"profile":  "Warm Analog",
		"bitDepth": "24",
		"format":   "json",
	})
	renderRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(renderRec, renderReq)
	renderRes := renderRec.Result()
	defer func() { _ = renderRes.Body.Close() }()
	if renderRes.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/master/render status = %d", renderRes.StatusCode)
	}

	// 4. Oversized upload -> 413
	hugePayload := bytes.Repeat([]byte("A"), 90*1024)
	hugeReq := newMultipartRequest(t, http.MethodPost, "/separate", "huge.wav", hugePayload, nil)
	hugeRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(hugeRec, hugeReq)
	hugeRes := hugeRec.Result()
	defer func() { _ = hugeRes.Body.Close() }()
	if hugeRes.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized upload, got %d", hugeRes.StatusCode)
	}

	// 5. Invalid parameter (stems=99) -> 400
	badStemsReq := newMultipartRequest(t, http.MethodPost, "/separate", "song.wav", wavBytes, map[string]string{"stems": "99"})
	badStemsRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(badStemsRec, badStemsReq)
	badStemsRes := badStemsRec.Result()
	defer func() { _ = badStemsRes.Body.Close() }()
	if badStemsRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for stems=99, got %d", badStemsRes.StatusCode)
	}
}
