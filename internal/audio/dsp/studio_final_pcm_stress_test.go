//go:build studio_stress

package dsp

import (
	"context"
	"math"
	"testing"
)

// This keeps the independent ideal-reconstruction challenge separate from a
// finite4x estimate pass. A finite estimate alone must not turn this gate green.
func TestStudioFinalFinite4xCorrectionNyquistSincGate(t *testing.T) {
	for _, count := range []int{2048, 8192} {
		source := make([]float32, count)
		for i := range source {
			source[i] = 1.8
			if i%2 == 1 {
				source[i] = -1.8
			}
		}
		original := studioGraphFinalFloat(t, 48000, source)
		input := make([]float32, count)
		for i := range input {
			input[i] = float32(original[i])
		}
		for _, bits := range []int{0, 16, 24} {
			a, _, report, err := prepareStudioFinalPCM(context.Background(), input, input, bits, -1)
			if err != nil {
				t.Fatal(err)
			}
			final := make([]float64, len(a))
			for i := range a {
				final[i] = float64(a[i])
			}
			longer, time := studioIndependentReconstruction64(final, 16384)
			direct := 0.0
			for step := -64; step <= 64; step++ {
				direct = math.Max(direct, math.Abs(studioGraphDirectSinc(final, time+float64(step)/4096)))
			}
			peak := 20 * math.Log10(math.Max(longer, direct))
			t.Logf("N%d bits%d finite4x %.9f→%.9f correction%.9fdB independent%.9fdBTP", count, bits, 20*math.Log10(report.BeforePeak), 20*math.Log10(report.AfterPeak), report.CorrectionDB, peak)
			if peak > -.95 {
				t.Errorf("OPEN: finite4x-only correction does not close N%d bits%d independent final-PCM ceiling: %.9fdBTP", count, bits, peak)
			}
		}
	}
}
