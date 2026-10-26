package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// The export budget is the base POST deadline plus 2 µs per source frame and
// 8 µs per converted output frame, capped at MaxExportBudget.
func TestExportBudgetScalesWithWorkAndIsCapped(t *testing.T) {
	cases := []struct {
		name                        string
		frames, sourceRate, outRate int
		want                        time.Duration
	}{
		{"one second unconverted", 44100, 44100, 44100, 60*time.Second + 88200*time.Microsecond},
		{"empty", 0, 44100, 44100, 60 * time.Second},
		{"negative", -5, 44100, 96000, 60 * time.Second},
		{"unknown output rate", 1000, 44100, 0, 60*time.Second + 2*time.Millisecond},
		{"max unconverted", 1 << 25, 48000, 48000, 60*time.Second + 67108864*time.Microsecond},
		// QA-2 acceptance shapes: 16,777,216 frames → 96 kHz and 33,554,432 → 44.1 kHz.
		{"16M to 96 kHz", 1 << 24, 48000, 96000, 60*time.Second + 33554432*time.Microsecond + 268435456*time.Microsecond},
		{"32M to 44.1 kHz", 1 << 25, 48000, 44100, 60*time.Second + 67108864*time.Microsecond + 246625080*time.Microsecond},
		{"capped", 1 << 40, 8000, 96000, server.MaxExportBudget},
	}
	for _, c := range cases {
		if got := server.ExportBudget(c.frames, c.sourceRate, c.outRate); got != c.want {
			t.Errorf("%s: budget %v, want %v", c.name, got, c.want)
		}
	}
	if server.PostRequestTimeout != 60*time.Second || server.MaxExportBudget != 10*time.Minute {
		t.Fatalf("base %v, ceiling %v", server.PostRequestTimeout, server.MaxExportBudget)
	}
	// Small exports stay on (almost exactly) the short base deadline.
	if got := server.ExportBudget(10*44100, 44100, 44100); got > server.PostRequestTimeout+time.Second {
		t.Fatalf("10 s export budget %v", got)
	}
}

// Upload and download deadlines grow with the byte count (10 s plus 8 MiB/s)
// and never exceed MaxTransferTime, so a slow small body is still cut off fast.
func TestTransferBudgetBoundsSlowBodies(t *testing.T) {
	cases := []struct {
		bytes int64
		want  time.Duration
	}{
		{-1, server.MaxTransferTime},
		{0, 10 * time.Second},
		{8 << 20, 11 * time.Second},
		{server.DefaultMaxUploadBytes, 10*time.Second + 32125*time.Millisecond},
		{1 << 40, server.MaxTransferTime},
	}
	for _, c := range cases {
		if got := server.TransferBudget(c.bytes); got != c.want {
			t.Errorf("%d bytes: budget %v, want %v", c.bytes, got, c.want)
		}
	}
	if server.MaxTransferTime != 60*time.Second {
		t.Fatalf("transfer ceiling %v", server.MaxTransferTime)
	}
}

func deadlineServer(t *testing.T, base, budget time.Duration, started func(context.Context)) *server.Server {
	t.Helper()
	srv := server.New(server.Config{Workers: 1})
	t.Cleanup(srv.Close)
	server.SetRequestTimingForTest(srv, base, func(int, int, int) time.Duration { return budget }, started)
	return srv
}

func postRender(t *testing.T, client *http.Client, url string, wav []byte, fields map[string]string) (status int, contentType string, body []byte) {
	t.Helper()
	req := newMultipartRequest(t, http.MethodPost, url, "source.wav", wav, fields)
	req.RequestURI, req.Host = "", ""
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err = io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp.StatusCode, resp.Header.Get("Content-Type"), body
}

// A render that outlives the base POST deadline (and the server's own write
// timeout) still completes inside its export budget: the request context, the
// connection write deadline and the response all survive.
func TestRenderOutlivesBaseDeadlineWithinExportBudget(t *testing.T) {
	const base = 250 * time.Millisecond
	deadlines := make(chan time.Time, 1)
	srv := deadlineServer(t, base, 5*time.Second, func(ctx context.Context) {
		deadline, _ := ctx.Deadline()
		deadlines <- deadline
		time.Sleep(3 * base) // Stands in for a long render.
	})
	ts := httptest.NewUnstartedServer(srv.Handler())
	ts.Config.WriteTimeout = 2 * base
	ts.Start()
	defer ts.Close()
	wav := buildTestWAV(t, 44100, 0.5)
	start := time.Now()
	status, contentType, body := postRender(t, ts.Client(), ts.URL+"/api/master/render", wav, map[string]string{"sampleRate": "96000"})
	if status != http.StatusOK || contentType != "audio/wav" {
		t.Fatalf("status %d: %s", status, body)
	}
	if want := 44 + 48000*6; len(body) < want {
		t.Fatalf("truncated WAV: %d bytes", len(body))
	}
	if left := (<-deadlines).Sub(start); left < 4*time.Second || left > 6*time.Second {
		t.Fatalf("export context deadline %v after start, want the 5 s budget", left)
	}
}

// When the export budget itself runs out, the 408 names the next step.
func TestExportBudgetExpiryNamesNextStep(t *testing.T) {
	srv := deadlineServer(t, 5*time.Second, 20*time.Millisecond, func(context.Context) { time.Sleep(150 * time.Millisecond) })
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", buildTestWAV(t, 44100, 0.5), map[string]string{"sampleRate": "96000"}))
	var got struct {
		Error  string `json:"error"`
		Detail string `json:"detail"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if w.Code != http.StatusRequestTimeout || got.Status != http.StatusRequestTimeout || got.Error != "export_timeout" {
		t.Fatalf("status %d: %+v", w.Code, got)
	}
	for _, want := range []string{"time budget", "shorter range", "lower sample rate"} {
		if !strings.Contains(got.Detail, want) {
			t.Fatalf("detail %q lacks %q", got.Detail, want)
		}
	}
}

type slowBody struct {
	r     io.Reader
	delay time.Duration
}

func (b *slowBody) Read(p []byte) (int, error) {
	time.Sleep(b.delay)
	return b.r.Read(p[:min(len(p), 4096)])
}

// An upload that misses the short base deadline never gets the export budget.
func TestSlowUploadKeepsShortBaseDeadline(t *testing.T) {
	granted := false
	srv := deadlineServer(t, 30*time.Millisecond, time.Minute, func(context.Context) { granted = true })
	req := newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", buildTestWAV(t, 44100, 0.5), nil)
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	req.Body = io.NopCloser(&slowBody{r: bytes.NewReader(raw), delay: 2 * time.Millisecond})
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusRequestTimeout || granted {
		t.Fatalf("status %d granted=%v: %s", w.Code, granted, w.Body.String())
	}
}

// Closing the client connection cancels an export that is inside its budget.
func TestClientDisconnectCancelsExport(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan error, 1)
	srv := deadlineServer(t, 5*time.Second, time.Minute, func(ctx context.Context) {
		close(started)
		select {
		case <-ctx.Done():
			canceled <- context.Cause(ctx)
		case <-time.After(10 * time.Second):
			canceled <- errors.New("export was not canceled")
		}
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := newMultipartRequest(t, http.MethodPost, ts.URL+"/api/master/render", "source.wav", buildTestWAV(t, 44100, 0.5), nil)
	req.RequestURI, req.Host = "", ""
	errs := make(chan error, 1)
	go func() {
		resp, err := ts.Client().Do(req.WithContext(ctx))
		if err == nil {
			_ = resp.Body.Close()
		}
		errs <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("export did not start")
	}
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("export context ended with %v", err)
	}
	if err := <-errs; err == nil {
		t.Fatal("canceled request returned a response")
	}
}
