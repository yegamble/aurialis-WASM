package main

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// This opt-in fixture generator lets verify.mjs compare a real compiled WASM
// bridge with native output from the same engine and exact float32 input bytes.
func TestWriteNativeParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_PARITY_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_PARITY_FIXTURE for compiled-WASM parity verification")
	}
	type fixture struct {
		Rate        float64    `json:"rate"`
		Params      dsp.Params `json:"params"`
		Left        []float32  `json:"left"`
		Right       []float32  `json:"right"`
		OutputLeft  []float32  `json:"outputLeft"`
		OutputRight []float32  `json:"outputRight"`
	}
	var fixtures []fixture
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, mode := range []string{"neutral", "gain", "chain", "bypass"} {
			p := dsp.DefaultParams()
			if mode == "gain" {
				p.InputGainDB = -6
			}
			if mode == "chain" || mode == "bypass" {
				p.InputGainDB = 3
				p.Bands[1].GainDB = -3
				p.Bands[3].GainDB = 2
				p.Compressor.Ratio = 4
				p.Compressor.ThresholdDB = -18
				p.Saturation.Amount = 25
				p.Stereo.WidthPct = 125
				p.Stereo.MonoBass = true
				p.Limiter.Enabled = true
				p.Bypass = mode == "bypass"
			}
			f := fixture{Rate: rate, Params: p, Left: make([]float32, 1024), Right: make([]float32, 1024), OutputLeft: make([]float32, 1024), OutputRight: make([]float32, 1024)}
			// Rational integer arithmetic produces exact identical native/JS inputs.
			for i := range f.Left {
				f.Left[i] = float32((i*73)%997-498) / 1024
				f.Right[i] = float32((i*31)%991-495) / 1024
			}
			bridge := NewBridge(rate)
			bridge.SetParams(p)
			for start := 0; start < len(f.Left); start += 128 {
				end := start + 128
				bridge.ProcessBlock(f.Left[start:end], f.Right[start:end], f.OutputLeft[start:end], f.OutputRight[start:end])
			}
			fixtures = append(fixtures, f)
		}
	}
	raw, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	} // #nosec G703 -- explicit local test fixture path, not a request path.
}
