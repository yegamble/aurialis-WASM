package server_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestCanonicalImportCarriesFiniteMeasurementsAndPreservesHeadroom(t *testing.T) {
	left, right := make([]float32, 1024), make([]float32, 1024)
	for i := range left {
		left[i] = float32(1.5 * math.Sin(2*math.Pi*997*float64(i)/48000))
		right[i] = -left[i] * 0.7
	}
	raw, err := audio.EncodeWAV(left, right, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	// An ordinary non-audio RIFF chunk must never survive canonicalization.
	raw = append(raw, []byte("JUNK\x04\x00\x00\x00META")...)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(len(raw)-8)) // #nosec G115 -- fixed small test fixture
	srv := server.New(server.Config{})
	defer srv.Close()
	r := newMultipartRequest(t, "POST", "/api/master/render", "source.wav", raw, map[string]string{
		"params": `{"bypass":true,"inputGainDb":12}`, "bitDepth": "32",
	})
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("import status=%d body=%s", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Length") != strconv.Itoa(44+len(left)*8) || w.Body.Len() != 44+len(left)*8 {
		t.Fatal("canonical frame count, Content-Length and body disagree")
	}
	header := w.Header().Get("X-Aurialis-Source-Metrics")
	if len(header) == 0 || len(header) > 4096 {
		t.Fatalf("source metrics header bytes=%d", len(header))
	}
	var metadata struct {
		SourceIdentity mastering.SourceIdentity `json:"sourceIdentity"`
		SampleRate     int                      `json:"sampleRate"`
		Frames         int                      `json:"frames"`
		Duration       float64                  `json:"duration"`
		BeforeMetrics  dsp.Metrics              `json:"beforeMetrics"`
		AfterMetrics   dsp.Metrics              `json:"afterMetrics"`
	}
	if err := json.Unmarshal([]byte(header), &metadata); err != nil {
		t.Fatalf("source metrics JSON was not finite and valid: %v", err)
	}
	if metadata.SampleRate != 48000 || metadata.Frames != len(left) || metadata.Duration != float64(len(left))/48000 {
		t.Fatalf("source metadata=%+v", metadata)
	}
	wantMetrics := dsp.MeasureStereo(left, right, 48000)
	if metadata.BeforeMetrics != wantMetrics || metadata.AfterMetrics != wantMetrics {
		t.Fatalf("source and bypass measurements differ: got=%+v want=%+v", metadata, wantMetrics)
	}
	wantWAV, err := audio.EncodeWAV(left, right, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(w.Body.Bytes(), wantWAV) {
		t.Fatal("bypass import altered source samples, float headroom or retained metadata")
	}
	canonical, err := audio.DecodeAndDisarm("canonical.wav", w.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	identity, err := mastering.SourceIdentityContext(context.Background(), canonical)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.SourceIdentity != identity || identity.SampleRate != metadata.SampleRate || identity.Frames != int64(metadata.Frames) || len(identity.PCMHash) != 64 {
		t.Fatalf("canonical import identity mismatch: header%+v decoded%+v", metadata.SourceIdentity, identity)
	}
}

func TestCanonicalImportFastPathDoesNotBypassActiveDSP(t *testing.T) {
	left := []float32{0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8}
	raw, err := audio.EncodeWAV(left, left, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(server.Config{})
	defer srv.Close()
	r := newMultipartRequest(t, "POST", "/api/master/render", "source.wav", raw, map[string]string{
		"params": `{"bypass":false,"inputGainDb":6}`, "bitDepth": "32",
	})
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("X-Aurialis-Source-Metrics") != "" {
		t.Fatalf("active render status=%d sourceHeader=%q", w.Code, w.Header().Get("X-Aurialis-Source-Metrics"))
	}
	decoded, err := audio.DecodeAndDisarm("rendered.wav", w.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	for i, sample := range decoded.Left {
		want := float64(left[i]) * math.Pow(10, 6.0/20)
		if math.Abs(float64(sample)-want) > 1e-6 {
			t.Fatalf("active gain frame%d got=%g want=%g", i, sample, want)
		}
	}
}
