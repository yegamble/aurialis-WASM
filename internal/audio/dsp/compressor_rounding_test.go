package dsp

import (
	"math"
	"testing"
)

// The envelope must round both products before summing on every architecture.
// An ARM fused multiply-add otherwise changes a later float32 export sample.
func TestCompressorEnvelopeUsesRoundedProducts(t *testing.T) {
	p := DefaultParams()
	p.Compressor.Enabled = true
	p.Compressor.ThresholdDB = -40
	p.Compressor.Ratio = 8
	p.Compressor.SidechainHPFHz = 0
	p.Compressor.AutoRelease = false
	e := NewEngine(48000)
	e.SetParams(p)
	attack, release := false, false
	for frame := 0; frame < 48000; frame++ {
		sample := .8
		if frame >= 24000 {
			sample = 0
		}
		model := e.compModel
		target, coefficient := model.target(sample, sample, &e.params.Compressor, &e.stages.compModel, e.stages.compRelease, e.compEnvDB)
		if target > e.compEnvDB {
			coefficient = e.stages.compAttack
			attack = true
		} else {
			release = true
		}
		want := float64(coefficient*e.compEnvDB) + float64((1-coefficient)*target)
		e.processCompressorSample(sample, sample)
		if math.Float64bits(e.compEnvDB) != math.Float64bits(want) {
			t.Fatalf("frame %d envelope %016x, rounded products %016x", frame, math.Float64bits(e.compEnvDB), math.Float64bits(want))
		}
	}
	if !attack || !release {
		t.Fatal("fixture must exercise attack and release")
	}
}

func TestPeakingCoefficientRoundsSquaredGain(t *testing.T) {
	sensitive := false
	for _, gain := range []float64{1.6, -2, .725} {
		band := BandParams{FreqHz: 1000, GainDB: gain, Q: 1, Type: FilterPeaking, Enabled: true}
		amp := math.Pow(10, gain/40)
		k := 1 / ((1 + .25*math.Abs(gain)) * amp)
		square := float64(amp * amp)
		want := k * (square - 1)
		got := computeBandCoeffs(48000, band).m1
		if math.Float64bits(got) != math.Float64bits(want) {
			t.Fatalf("gain %g coefficient %016x, rounded square %016x", gain, math.Float64bits(got), math.Float64bits(want))
		}
		sensitive = sensitive || math.FMA(amp, amp, -1) != square-1
	}
	if !sensitive {
		t.Fatal("fixture must distinguish fused square/subtraction")
	}
}
