//go:build studio_stress

package dsp

import (
	"context"
	"errors"
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

// This deliberately bounded R&D checker uses at most65536 FFT input bins and
// 64x inverse bins (about65MiB/channel scratch), plus an independent direct sinc
// sum near the larger-padding FFT maximum. It is not a universal ideal-sinc
// certificate or a scalable song-length implementation. No later trim occurs.
func studioBoundedFinalIndependent(ctx context.Context, left, right []float32) (float64, error) {
	if len(left) > 16384 {
		return 0, errors.New("private independent verification supports at most16384 frames")
	}
	peak := 0.0
	same := true
	for i := range left {
		same = same && math.Float32bits(left[i]) == math.Float32bits(right[i])
	}
	channels := [][]float32{left, right}
	if same {
		channels = channels[:1]
	}
	for _, channel := range channels {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		samples := make([]float64, len(channel))
		for i, x := range channel {
			samples[i] = float64(x)
		}
		maximum, time := studioIndependentReconstruction64(samples, 16384)
		peak = math.Max(peak, maximum)
		for step := -64; step <= 64; step++ {
			if step%32 == 0 {
				if err := ctx.Err(); err != nil {
					return 0, err
				}
			}
			peak = math.Max(peak, math.Abs(studioGraphDirectSinc(samples, time+float64(step)/4096)))
		}
	}
	return peak, ctx.Err()
}

func TestStudioFinalIndependentCorrectionNyquistOutput(t *testing.T) {
	verifier := studioFinalIndependentVerifier{name: "64x-pad16384-direct-finite-local129-candidate1", measure: studioBoundedFinalIndependent}
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
			a, b, report, err := prepareStudioFinalPCMChecked(context.Background(), input, input, bits, -1, verifier)
			if err != nil {
				t.Fatal(err)
			}
			if len(a) != count || len(b) != count || report.IndependentEstimator != verifier.name || report.BeforeIndependentPeak <= dbToLin(-.95) || report.AfterIndependentPeak > dbToLin(-1) || report.AfterPeak > dbToLin(-1) || report.CorrectionDB >= 0 || report.AfterIndependentPeak < dbToLin(-1.1) {
				t.Fatalf("independent exact-final-output correction failed: %+v", report)
			}
			t.Logf("N%d bits%d independent%.9f→%.9fdBTP finite4x%.9fdBTP reported correction%.9fdB passes%d", count, bits, 20*math.Log10(report.BeforeIndependentPeak), 20*math.Log10(report.AfterIndependentPeak), 20*math.Log10(report.AfterPeak), report.CorrectionDB, report.Passes)
		}
	}
}
