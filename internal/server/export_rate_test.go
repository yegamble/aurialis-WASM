package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// Exports can convert to a delivery rate and choose dither. Conversion happens
// after mastering, then the ceiling and dither are applied once at the new rate.
func TestExportSampleRateAndDither(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	const rate, frames = 44100, 44100
	l, r := make([]float32, frames), make([]float32, frames)
	for i := range l {
		l[i] = float32(0.5 * math.Sin(2*math.Pi*997*float64(i)/rate))
		r[i] = l[i] * 0.8
	}
	wav, err := audio.EncodeWAV(l, r, rate, 32)
	if err != nil {
		t.Fatal(err)
	}
	params := dsp.DefaultParams()
	params.InputGainDB = 6
	params.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	params.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 100, TruePeak: true}
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	post := func(fields map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, fields))
		return recorder
	}
	decode := func(recorder *httptest.ResponseRecorder) *audio.Buffer {
		t.Helper()
		if recorder.Code != http.StatusOK {
			t.Fatalf("render %d: %s", recorder.Code, recorder.Body.String())
		}
		out, err := audio.DecodeAndDisarm("render.wav", recorder.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	source := decode(post(map[string]string{"params": string(encoded), "bitDepth": "24"}))
	sourceLevel := dsp.MeasureStereo(source.Left, source.Right, rate)
	for _, to := range []int{48000, 88200, 96000} {
		out := decode(post(map[string]string{"params": string(encoded), "bitDepth": "24", "sampleRate": strconv.Itoa(to)}))
		if out.SampleRate != to || out.Frames != (frames*to+rate-1)/rate {
			t.Fatalf("%d Hz export layout %d Hz × %d frames", to, out.SampleRate, out.Frames)
		}
		m := dsp.MeasureStereo(out.Left, out.Right, float64(to))
		if math.Abs(m.IntegratedLUFS-sourceLevel.IntegratedLUFS) > 0.05 || m.SamplePeakDBFS > -1 {
			t.Fatalf("%d Hz: %.2f LUFS (source %.2f), sample peak %.2f dBFS", to, m.IntegratedLUFS, sourceLevel.IntegratedLUFS, m.SamplePeakDBFS)
		}
	}
	same := post(map[string]string{"params": string(encoded), "bitDepth": "24", "sampleRate": "44100"})
	if !bytes.Equal(same.Body.Bytes(), post(map[string]string{"params": string(encoded), "bitDepth": "24"}).Body.Bytes()) {
		t.Fatal("converting to the source rate must equal the unconverted export")
	}
	dithered := decode(post(map[string]string{"params": string(encoded), "bitDepth": "16", "sampleRate": "48000"}))
	plain := decode(post(map[string]string{"params": string(encoded), "bitDepth": "16", "sampleRate": "48000", "dither": "none"}))
	differs := false
	for i := range plain.Left {
		if plain.Left[i] != dithered.Left[i] {
			differs = true
			break
		}
	}
	if !differs {
		t.Fatal("dither none produced the dithered export")
	}
	for _, raw := range []string{"22050", "fast", "0", "+48000", "048000", " 48000 ", "48000\r\n", "48000.0", "4.8e4", "-48000"} {
		recorder := post(map[string]string{"sampleRate": raw})
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_sample_rate"`) {
			t.Errorf("sampleRate %q: status %d %.200s, want 400 invalid_sample_rate", raw, recorder.Code, recorder.Body.String())
		}
	}
	for _, raw := range []string{"shaped", " none", "NONE", "tpdf\n"} {
		recorder := post(map[string]string{"dither": raw})
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_export_options"`) {
			t.Errorf("dither %q: status %d %.200s, want 400 invalid_export_options", raw, recorder.Code, recorder.Body.String())
		}
	}
	// A comma inside one field is just an invalid value; a field sent twice is
	// rejected by the multipart reader before any value is used.
	if code := post(map[string]string{"dither": "none,none"}).Code; code != http.StatusBadRequest {
		t.Errorf("dither none,none: status %d, want 400", code)
	}
	for _, field := range []string{"sampleRate", "dither"} {
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, repeatedFieldRequest(t, "/api/master/render", wav, field, []string{"48000", "48000"}))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_multipart"`) {
			t.Errorf("repeated %s: status %d %.200s, want 400 invalid_multipart", field, recorder.Code, recorder.Body.String())
		}
	}
}

func repeatedFieldRequest(t *testing.T, target string, wav []byte, field string, values []string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "source.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(wav); err != nil {
		t.Fatal(err)
	}
	for _, value := range values {
		if err := form.WriteField(field, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, target, &body)
	request.Host = "127.0.0.1:8080"
	request.Header.Set("Content-Type", form.FormDataContentType())
	return request
}

// Export conversion fields belong to the render endpoint only.
func TestExportFieldsRejectedOutsideRender(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	l := make([]float32, 8000)
	wav, err := audio.EncodeWAV(l, l, 8000, 16)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/api/analyze/deep", "/api/separate", "/api/analyze/features"} {
		for _, fields := range []map[string]string{{"sampleRate": "48000"}, {"dither": "none"}, {"sampleRate": "22050", "dither": "bogus"}} {
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, target, "source.wav", wav, fields))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_multipart"`) {
				t.Errorf("%s %v: status %d %s, want 400 invalid_multipart", target, fields, recorder.Code, recorder.Body.String())
			}
		}
	}
}

// Conversions that cannot be delivered are rejected before rendering.
func TestExportConversionLimitsRejectBeforeRender(t *testing.T) {
	if testing.Short() {
		t.Skip("uploads a 5.6 MB source")
	}
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	post := func(rate, frames int, to string) *httptest.ResponseRecorder {
		t.Helper()
		silent := make([]float32, frames)
		wav, err := audio.EncodeWAV(silent, silent, rate, 16)
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"sampleRate": to, "format": "json"}))
		return recorder
	}
	// 8 kHz × 12 = 96 kHz: one frame past the 33,554,432-frame output bound.
	frames := audio.MaxDecodedFrames/12 + 1
	start := time.Now()
	recorder := post(8000, frames, "96000")
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_export_options"`) || !strings.Contains(recorder.Body.String(), "track length limit") {
		t.Fatalf("over-length conversion: status %d %s", recorder.Code, recorder.Body.String())
	}
	t.Logf("over-length conversion rejected in %v", time.Since(start))
	// 44056 Hz → 48 kHz reduces to 6000/5507, beyond the exact polyphase bound.
	recorder = post(44056, 4096, "48000")
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"invalid_export_options"`) || !strings.Contains(recorder.Body.String(), "too complex") {
		t.Fatalf("complex ratio: status %d %s", recorder.Code, recorder.Body.String())
	}
}
