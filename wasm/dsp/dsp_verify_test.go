package main

import (
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestWASMBridgeWorkletQuantumAndIsolation(t *testing.T) {
	bridge := NewBridge(48000.0)

	// Verify SetParamsJSON partial/full updates and SetBand isolation
	if err := bridge.SetParamsJSON(`{"inputGainDb": 3.0}`); err != nil {
		t.Fatalf("SetParamsJSON failed: %v", err)
	}
	if bridge.Params().InputGainDB != 3.0 {
		t.Fatalf("expected InputGainDB=3.0, got %v", bridge.Params().InputGainDB)
	}

	b2 := bridge.Params().Bands[2]
	b2.GainDB = -4.5
	bridge.SetBand(2, b2)
	got := bridge.Params()
	if got.Bands[2].GainDB != -4.5 {
		t.Fatalf("expected Band[2].GainDB=-4.5, got %v", got.Bands[2].GainDB)
	}
	if got.Bands[0].GainDB != 0 || got.Bands[1].GainDB != 0 || got.Bands[3].GainDB != 0 || got.Bands[4].GainDB != 0 {
		t.Fatalf("SetBand(2) mutated adjacent EQ bands: %+v", got.Bands)
	}
	if got.InputGainDB != 3.0 {
		t.Fatalf("SetBand(2) reset InputGainDB: got %v", got.InputGainDB)
	}

	// Process 100 consecutive 128-frame AudioWorklet quanta
	bridge.Reset()
	bridge.SetParams(dsp.DefaultParams())
	inL := make([]float32, 128)
	inR := make([]float32, 128)
	outL := make([]float32, 128)
	outR := make([]float32, 128)
	for i := 0; i < 128; i++ {
		s := float32(0.5 * math.Sin(2.0*math.Pi*1000.0*float64(i)/48000.0))
		inL[i] = s
		inR[i] = s
	}
	for block := 0; block < 100; block++ {
		bridge.ProcessBlock(inL, inR, outL, outR)
	}
	m := bridge.Measure(outL, outR)
	if math.IsNaN(m.IntegratedLUFS) || m.IntegratedLUFS < -15.0 || m.IntegratedLUFS > -5.0 {
		t.Fatalf("unexpected LUFS from 128-frame worklet blocks: %+v", m)
	}
}

func TestWASMBridgeBoundaryAndAdversarialSignals(t *testing.T) {
	for _, sr := range []float64{44100.0, 48000.0, 96000.0} {
		bridge := NewBridge(sr)
		p := dsp.DefaultParams()
		p.Bands[0].GainDB = 4.0
		p.Bands[4].GainDB = 4.0
		p.Compressor.Enabled = true
		p.Compressor.ThresholdDB = -12.0
		p.Compressor.Ratio = 4.0
		p.Saturation.Enabled = true
		p.Saturation.Amount = 80.0
		p.Saturation.Character = dsp.SatCrisp
		p.Stereo.MonoBass = true
		p.Limiter.Enabled = true
		p.Limiter.CeilingDBTP = -1.0
		p.DitherBits = 24
		bridge.SetParams(p)

		// Construct adversarial block: 0 dBFS square wave, DC step, denormal 1e-40, NaN, +Inf, -Inf, silence
		inL := make([]float32, 512)
		inR := make([]float32, 512)
		outL := make([]float32, 512)
		outR := make([]float32, 512)
		for i := 0; i < 512; i++ {
			switch {
			case i < 128:
				if i%16 < 8 {
					inL[i], inR[i] = 1.0, -1.0
				} else {
					inL[i], inR[i] = -1.0, 1.0
				}
			case i < 256:
				inL[i], inR[i] = 0.85, 0.85 // DC step
			case i < 384:
				inL[i], inR[i] = float32(1e-40), float32(-1e-40) // subnormal/denormal
			case i == 400:
				inL[i] = float32(math.NaN())
				inR[i] = float32(math.Inf(1))
			case i == 401:
				inL[i] = float32(math.Inf(-1))
				inR[i] = float32(math.NaN())
			default:
				inL[i], inR[i] = 0.0, 0.0
			}
		}

		bridge.ProcessBlock(inL, inR, outL, outR)
		for i := 0; i < 512; i++ {
			if math.IsNaN(float64(outL[i])) || math.IsInf(float64(outL[i]), 0) {
				t.Fatalf("sr=%v: NaN/Inf in outL[%d]=%v", sr, i, outL[i])
			}
			if math.IsNaN(float64(outR[i])) || math.IsInf(float64(outR[i]), 0) {
				t.Fatalf("sr=%v: NaN/Inf in outR[%d]=%v", sr, i, outR[i])
			}
			if math.Abs(float64(outL[i])) > 1.0 || math.Abs(float64(outR[i])) > 1.0 {
				t.Fatalf("sr=%v: sample exceeded 0 dBFS ceiling at %d: (%v, %v)", sr, i, outL[i], outR[i])
			}
		}
	}
}
