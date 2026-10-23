package dsp

import (
	"math"
	"testing"
)

func studioGraphFinalFloat(t *testing.T, rate float64, source []float32) []float64 {
	t.Helper()
	p := studioGraphNeutralParams()
	p.Limiter.Enabled = true
	p.Limiter.TruePeak = true
	g := mustStudioGraph(t, rate, p, len(source), false)
	a, _ := renderStudioGraph(t, g, source, source, 129)
	// These are exactly the compensated exported float32 samples. The oracle
	// supplies zeros outside this record and measures its reconstruction tails.
	final := make([]float64, len(source))
	for i := range final {
		final[i] = float64(a[g.latency+i])
	}
	return final
}

func studioGraphFinalPeak(t *testing.T, rate float64, source []float32) float64 {
	t.Helper()
	return 20 * math.Log10(studioIndependentPeak64(studioGraphFinalFloat(t, rate, source)))
}

func TestStudioGraphFiniteFloatOutputHFSweep(t *testing.T) {
	worst := -1000.0
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		local := -1000.0
		for _, count := range []int{257, 2048, 8192} {
			for _, phase := range []float64{0, math.Pi / 16, math.Pi / 4, 3 * math.Pi / 8, 1.7} {
				source := make([]float32, count)
				for i := range source {
					source[i] = float32(1.8 * math.Sin(2*math.Pi*.49*float64(i)+phase))
				}
				peak := studioGraphFinalPeak(t, rate, source)
				local = math.Max(local, peak)
				if peak > -.95 {
					t.Fatalf("rate%g count%d phase%g final float output%g dBTP exceeds ceiling+.05", rate, count, phase, peak)
				}
			}
		}
		worst = math.Max(worst, local)
		t.Logf("rate%.0f exact finite float output worst %.9f dBTP", rate, local)
	}
	t.Logf("75-case final float output worst %.9f dBTP", worst)
}

func TestStudioGraphFinalFloatOutputImpulseDCAndTwoTone(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for mode := range 5 {
			source := make([]float32, 2048)
			for i := range source {
				switch mode {
				case 0:
					if i == 0 {
						source[i] = 1.8
					}
				case 1:
					if i == len(source)-1 {
						source[i] = 1.8
					}
				case 2:
					source[i] = 1.8
				case 3:
					source[i] = float32(1.1*math.Sin(2*math.Pi*.173*float64(i)) + .9*math.Sin(2*math.Pi*.319*float64(i)+.6))
				case 4:
					source[i] = float32(1.8 * math.Sin(2*math.Pi*40*float64(i)/rate))
				}
			}
			peak := studioGraphFinalPeak(t, rate, source)
			if peak > -.95 {
				t.Fatalf("rate%g mode%d final float output%g dBTP exceeds ceiling+.05", rate, mode, peak)
			}
		}
	}
}

// This direct finite-record sinc sum shares no FFT, FIR coefficient or production
// peak polynomial. Compensated accumulation keeps the near-peak check stable.
func studioGraphDirectSinc(samples []float64, time float64) float64 {
	nearest := math.Round(time)
	if math.Abs(time-nearest) < 1e-12 {
		index := int(nearest)
		if index >= 0 && index < len(samples) {
			return samples[index]
		}
		return 0
	}
	sum, correction := 0.0, 0.0
	for i, x := range samples {
		value := x / (time - float64(i))
		if i&1 != 0 {
			value = -value
		}
		term := value - correction
		next := sum + term
		correction = (next - sum) - term
		sum = next
	}
	return math.Sin(math.Pi*time) / math.Pi * sum
}

func TestStudioGraphFinalFloatPeakPaddingAndDirectSinc(t *testing.T) {
	cases := []struct {
		rate  float64
		count int
		phase float64
	}{{8000, 2048, 3 * math.Pi / 8}, {44100, 8192, 0}, {48000, 8192, 0}, {96000, 2048, 0}, {192000, 8192, math.Pi / 16}}
	for _, tc := range cases {
		source := make([]float32, tc.count)
		for i := range source {
			source[i] = float32(1.8 * math.Sin(2*math.Pi*.49*float64(i)+tc.phase))
		}
		final := studioGraphFinalFloat(t, tc.rate, source)
		short := 20 * math.Log10(studioIndependentPeak64(final))
		maximum, time := studioIndependentReconstruction64(final, 16384)
		longer := 20 * math.Log10(maximum)
		direct := 0.0
		for step := -64; step <= 64; step++ {
			direct = math.Max(direct, math.Abs(studioGraphDirectSinc(final, time+float64(step)/4096)))
		}
		directDB := 20 * math.Log10(direct)
		t.Logf("rate%.0f final float short %.9f longer %.9f direct %.9f dBTP at %.9f", tc.rate, short, longer, directDB, time)
		if longer > -.95 || directDB > -.95 {
			t.Fatal("independent longer-padding/direct-sinc check exceeded ceiling+.05")
		}
		if math.Abs(longer-directDB) > .005 {
			t.Fatal("larger-padding FFT and direct finite sum have not converged")
		}
	}
}

func TestStudioGraphDitherFinalFloatPeaks(t *testing.T) {
	cases := []struct {
		rate  float64
		count int
		phase float64
	}{{8000, 2048, 3 * math.Pi / 8}, {44100, 8192, 0}, {48000, 8192, 0}, {96000, 2048, 0}, {192000, 8192, math.Pi / 16}}
	for _, tc := range cases {
		for _, bits := range []int{0, 16, 24} {
			p := studioGraphNeutralParams()
			p.Limiter.Enabled = true
			p.DitherBits = bits
			source := make([]float32, tc.count)
			for i := range source {
				source[i] = float32(1.8 * math.Sin(2*math.Pi*.49*float64(i)+tc.phase))
			}
			g := mustStudioGraph(t, tc.rate, p, len(source), false)
			a, _ := renderStudioGraph(t, g, source, source, 129)
			final := make([]float64, len(source))
			for i := range final {
				final[i] = float64(a[g.latency+i])
			}
			peak := 20 * math.Log10(studioIndependentPeak64(final))
			if peak > -.95 {
				t.Fatalf("rate%g bits%d final quantized float peak%.9f exceeds ceiling+.05", tc.rate, bits, peak)
			}
		}
	}
}
