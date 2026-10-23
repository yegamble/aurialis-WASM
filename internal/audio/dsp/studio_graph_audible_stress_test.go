//go:build studio_stress

package dsp

import (
	"math"
	"testing"
)

// This separately named candidate intentionally filters above its audible
// passband. The old graph's exact-Nyquist and full-frequency failures remain intact.
// The oracle still measures exactly N exported float32 samples with zero exterior.
func TestStudioAudibleGraphFiniteNyquistFinalOutput(t *testing.T) {
	for _, count := range []int{2048, 8192} {
		for _, bits := range []int{0, 16, 24} {
			source := make([]float32, count)
			for i := range source {
				source[i] = 1.8
				if i%2 != 0 {
					source[i] = -1.8
				}
			}
			p := studioGraphNeutralParams()
			p.Limiter.Enabled, p.Limiter.TruePeak, p.DitherBits = true, true, bits
			g := mustStudioAudibleGraph(t, 48000, p, count, false)
			a, _ := renderStudioGraph(t, g, source, source, 129)
			final := make([]float64, count)
			for i := range final {
				final[i] = float64(a[g.latency+i])
			}
			short := studioIndependentPeak64(final)
			longer, time := studioIndependentReconstruction64(final, 16384)
			direct := 0.0
			for step := -64; step <= 64; step++ {
				direct = math.Max(direct, math.Abs(studioGraphDirectSinc(final, time+float64(step)/4096)))
			}
			peak := 20 * math.Log10(math.Max(short, math.Max(longer, direct)))
			t.Logf("audible candidate N%d bits%d short%.9f longer%.9f direct%.9f dBTP", count, bits, 20*math.Log10(short), 20*math.Log10(longer), 20*math.Log10(direct))
			if peak > -.95 {
				t.Errorf("OPEN: audible candidate N%d bits%d final output%.9f dBTP exceeds unchanged ceiling+.05", count, bits, peak)
			}
		}
	}
}

func TestStudioAudibleGraphFiniteOutputStressCorpus(t *testing.T) {
	worst := -1000.0
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		local := -1000.0
		for mode := range 6 {
			source := make([]float32, 2048)
			for i := range source {
				switch mode {
				case 0:
					source[i] = float32(1.8 * math.Sin(2*math.Pi*.49*float64(i)+3*math.Pi/8))
				case 1:
					if i == 0 {
						source[i] = 1.8
					}
				case 2:
					if i == len(source)-1 {
						source[i] = 1.8
					}
				case 3:
					source[i] = 1.8
				case 4:
					source[i] = float32(1.1*math.Sin(2*math.Pi*.173*float64(i)) + .9*math.Sin(2*math.Pi*.319*float64(i)+.6))
				case 5:
					source[i] = float32(1.8 * math.Sin(2*math.Pi*40*float64(i)/rate))
				}
			}
			p := studioGraphNeutralParams()
			p.Limiter.Enabled, p.Limiter.TruePeak = true, true
			g := mustStudioAudibleGraph(t, rate, p, len(source), false)
			a, _ := renderStudioGraph(t, g, source, source, 129)
			final := make([]float64, len(source))
			for i := range final {
				final[i] = float64(a[g.latency+i])
			}
			peak := 20 * math.Log10(studioIndependentPeak64(final))
			local = math.Max(local, peak)
			if peak > -.95 {
				t.Errorf("OPEN: rate%g mode%d exact final output%.9fdBTP exceeds unchanged ceiling+.05", rate, mode, peak)
			}
		}
		worst = math.Max(worst, local)
		t.Logf("rate%.0f six-case finite output worst%.9fdBTP", rate, local)
	}
	t.Logf("30-case exact final float output worst%.9fdBTP", worst)
}
