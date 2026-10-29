package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

type oversampledParityFixture struct {
	nativeParityFixture
	TailLeft  []float32 `json:"tailLeft"`
	TailRight []float32 `json:"tailRight"`
	Latency   int       `json:"latency"`
}

func TestOversampledLivePlaybackRendersTheFiniteExport(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, character := range []dsp.SatCharacter{dsp.SatTube, dsp.SatTape, dsp.SatTransformer} {
			p := heaviestLiveParams(dsp.OversampledAlgorithmVersion, character)
			left, right := denseMix(rate, 1)
			left, right = left[:int(rate*.031)], right[:int(rate*.031)]
			left[len(left)-1], right[len(right)-1] = .9, -.8
			wantL, wantR, _, err := dsp.RenderBufferContext(context.Background(), left, right, rate, p)
			if err != nil {
				t.Fatal(err)
			}
			gotL, gotR, _ := livePlayback(t, rate, left, right, p)
			for i := range gotL {
				if gotL[i] != wantL[i] || gotR[i] != wantR[i] {
					t.Fatalf("rate %g %s frame %d differs from finite export", rate, character, i)
				}
			}
		}
	}
}

// TestWriteOversampledParityFixture exercises real WASI controls, processing,
// source-end tail and reset against native values. It does not replace frozen
// algorithm-1 fixtures or the real AudioWorklet CPU gate.
func TestWriteOversampledParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_OVERSAMPLED_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_OVERSAMPLED_FIXTURE for compiled WASI parity")
	}
	var fixtures []oversampledParityFixture
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, character := range []dsp.SatCharacter{dsp.SatWarm, dsp.SatThick, dsp.SatCrisp, dsp.SatTube, dsp.SatTape, dsp.SatTransformer, dsp.SatClean} {
			p := heaviestLiveParams(dsp.OversampledAlgorithmVersion, character)
			left, right := make([]float32, 4096), make([]float32, 4096)
			for i := range left {
				left[i] = float32(.51*math.Sin(float64(i)*.713) + .32*math.Cos(float64(i)*1.3))
				right[i] = float32(.37*math.Sin(float64(i)*.93) - .41*math.Cos(float64(i)*.1))
			}
			b := NewBridge(rate)
			if !b.SetParams(p) {
				t.Fatal("params rejected")
			}
			l, r := make([]float32, len(left)), make([]float32, len(right))
			for i := 0; i < len(left); i += 128 {
				if !b.ProcessBlock(left[i:i+128], right[i:i+128], l[i:i+128], r[i:i+128]) {
					t.Fatal("block rejected")
				}
			}
			tailL, tailR := make([]float32, b.LatencyFrames()), make([]float32, b.LatencyFrames())
			if b.Drain(tailL, tailR) != len(tailL) {
				t.Fatal("incomplete tail")
			}
			fixtures = append(fixtures, oversampledParityFixture{nativeParityFixture: nativeParityFixture{Rate: rate, Params: p, Left: left, Right: right, OutputLeft: l, OutputRight: r}, TailLeft: tailL, TailRight: tailR, Latency: len(tailL)})
		}
	}
	encoded, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Test-only local fixture path, never request data.
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
}
