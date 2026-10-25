package dsp

import (
	"math"
	"testing"
)

// Audit finding 14: the linked ceiling after dither scaled samples off the
// quantization grid. Dithered limiter output must stay on its grid.
func TestDitheredLimiterOutputStaysOnGrid(t *testing.T) {
	for _, bits := range []int{16, 24} {
		p := DefaultParams()
		p.InputGainDB = 6
		p.DitherBits = bits
		p.Limiter = LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 80}
		e := NewEngine(48000)
		e.SetParams(p)
		in := make([]float32, 48000)
		for i := range in {
			in[i] = float32(0.9 * math.Sin(2*math.Pi*997*float64(i)/48000))
		}
		outL, outR := make([]float32, len(in)), make([]float32, len(in))
		e.ProcessBlock(in, in, outL, outR)
		scale, ceiling := math.Ldexp(1, bits-1), dbToLin(-1)
		for i := range outL {
			for _, v := range []float64{float64(outL[i]), float64(outR[i])} {
				if k := v * scale; math.Abs(k-math.Round(k)) > 1e-3 || math.Abs(v) > ceiling+1e-9 {
					t.Fatalf("%d-bit frame %d: %v is off grid or above the ceiling", bits, i, v)
				}
			}
		}
	}
}
