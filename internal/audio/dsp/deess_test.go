package dsp

import (
	"math"
	"testing"
)

// Audit finding 6: the de-esser subtracted its Q=2 band at double gain, so 6 dB
// nulled a 6.5 kHz tone and 10 dB inverted it. Its cut must now grow with the
// setting and stay within deEssDb.
func TestDeEsserCutIsMonotonicAndBounded(t *testing.T) {
	for _, level := range []float64{-12, -6} {
		previous := 0.0
		for _, setting := range []float64{1, 2.4, 4.2, 6, 8, 10, 12, 18, 24} {
			p := DefaultParams()
			p.Repair = RepairParams{Enabled: true, DeEssDB: setting}
			in, out := sineThrough(p, 6500, math.Pow(10, level/20))
			cut := -levelChangeDB(in, out)
			if cut < previous-0.01 || cut > setting+0.05 || cut < 0 {
				t.Fatalf("%g dBFS, %g dB setting: cut %.2f dB (previous %.2f)", level, setting, cut, previous)
			}
			previous = cut
		}
		if previous < 23 {
			t.Fatalf("%g dBFS: a loud 6.5 kHz tone at 24 dB cut only %.2f dB", level, previous)
		}
	}
}

func sineThrough(p Params, freq, amp float64) ([]float32, []float32) {
	const rate = 48000
	e := NewEngine(rate)
	e.SetParams(p)
	in := make([]float32, rate)
	for i := range in {
		in[i] = float32(amp * math.Sin(2*math.Pi*freq*float64(i)/rate))
	}
	outL, outR := make([]float32, rate), make([]float32, rate)
	e.ProcessBlock(in, in, outL, outR)
	return in[rate/2:], outL[rate/2:]
}
