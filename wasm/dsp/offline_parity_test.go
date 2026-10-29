package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
)

type offlineParityFixture struct {
	Request     string `json:"request"`
	Source      []byte `json:"source"` // base64 in JSON
	AudioSHA256 string `json:"audioSha256"`
	Metadata    string `json:"metadata"`
}

// This opt-in fixture generator lets verify-offline.mjs check that the
// compiled browser worker (aurialisOfflineJob) renders exports, including
// sample-rate conversion, delivery limiting and TPDF dither, byte for byte as
// the native build does.
func TestWriteOfflineJobParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_OFFLINE_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_OFFLINE_FIXTURE for compiled-WASM offline job parity verification")
	}
	const rate = 48000
	left, right := make([]float32, rate/2), make([]float32, rate/2)
	state := uint32(0x2545F491)
	for i := range left {
		state = state*1664525 + 1013904223
		noise := 2*float64(state)/math.MaxUint32 - 1
		at := float64(i) / rate
		left[i] = float32(0.5*math.Sin(2*math.Pi*997*at) + 0.25*math.Sin(2*math.Pi*17000*at) + 0.2*noise)
		right[i] = float32(0.5*math.Sin(2*math.Pi*1499*at) - 0.25*math.Sin(2*math.Pi*19500*at) - 0.2*noise)
	}
	source, err := audio.EncodeWAV(left, right, rate, 24)
	if err != nil {
		t.Fatal(err)
	}
	hot := dsp.DefaultParams()
	hot.InputGainDB = 9
	hot.Limiter.Enabled = true
	hotV2 := hot
	hotV2.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	hotV3 := heaviestLiveParams(dsp.OversampledAlgorithmVersion, dsp.SatTube)
	var fixtures []offlineParityFixture
	for _, c := range []struct {
		params               dsp.Params
		bitDepth, sampleRate int
		dither               string
	}{
		{hot, 24, 0, ""},
		{hot, 16, 0, ""},
		{hot, 24, 44100, "none"},
		{hot, 24, 96000, ""},
		{hot, 16, 44100, "tpdf"},
		{hotV2, 16, 88200, ""},
		{hotV3, 24, 0, "none"},
		{hotV3, 16, 44100, "tpdf"},
		{hot, 32, 44100, ""},
	} {
		params, err := json.Marshal(c.params)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(browserjobs.Request{Operation: "render", Params: string(params), BitDepth: c.bitDepth, SampleRate: c.sampleRate, Dither: c.dither})
		if err != nil {
			t.Fatal(err)
		}
		result, err := browserjobs.Execute(context.Background(), raw, source, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(result.Audio)
		fixtures = append(fixtures, offlineParityFixture{Request: string(raw), Source: source, AudioSHA256: hex.EncodeToString(sum[:]), Metadata: string(result.Metadata)})
	}
	encoded, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Test-only artifact path supplied by the local parity harness, never an upload or HTTP request.
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
}
