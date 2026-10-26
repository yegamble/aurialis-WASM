package dsp

import (
	"context"
	"math"
	"testing"
)

// This predictable truth gate cannot establish general reconstruction quality.
func TestStudioARRepairPredictableTruthAndUntouchedBytes(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		const threshold = .7
		const count = 4096
		clean, clipped := make([]float32, count), make([]float32, count)
		for i := range clean {
			clean[i] = float32(math.Sin(2*math.Pi*997*float64(i)/rate + .31))
			clipped[i] = float32(math.Max(-threshold, math.Min(threshold, float64(clean[i]))))
		}
		output, other, report, err := repairStudioClippedPCM(context.Background(), rate, threshold, clipped, clipped)
		if err != nil {
			t.Fatal(err)
		}
		before, after := 0.0, 0.0
		for i := range clean {
			x, y := float64(clipped[i]-clean[i]), float64(output[i]-clean[i])
			before, after = before+x*x, after+y*y
			if math.Float32bits(output[i]) != math.Float32bits(other[i]) {
				t.Fatal("identical channel contexts produced different estimates")
			}
			if math.Abs(float64(clipped[i])) < report.Threshold && math.Float32bits(output[i]) != math.Float32bits(clipped[i]) {
				t.Fatal("reliable sample bytes changed")
			}
		}
		delta := 10 * math.Log10(after/before)
		t.Logf("rate%.0f known-clean sine error delta%.6fdB accepted%d unresolved%d", rate, delta, report.Channels[0].AcceptedRuns, report.Channels[0].UnresolvedRuns)
		if report.Channels[0].ChangedSamples == 0 || delta > -3 {
			t.Error("private predictor did not improve its predictable truth fixture by3dB")
		}
	}
}

func TestStudioARRepairExactSilenceDCBoundaryAndLongRun(t *testing.T) {
	source := make([]float32, 1024)
	for i := range source {
		source[i] = .2
	}
	source[0] = math.Float32frombits(0x80000000)
	source[1] = math.Float32frombits(1)
	for i := 200; i < 400; i++ {
		source[i] = .7
	}
	source[len(source)-1] = -.7
	output, _, report, err := repairStudioClippedPCM(context.Background(), 48000, .7, source, source)
	if err != nil {
		t.Fatal(err)
	}
	for i := range source {
		if math.Float32bits(output[i]) != math.Float32bits(source[i]) {
			t.Fatal("unsupported source or untouched signed-zero/DC bytes changed")
		}
	}
	if report.Channels[0].UnresolvedRuns != 2 || report.Channels[0].ChangedSamples != 0 {
		t.Fatal("unsupported long/boundary runs were not reported unchanged")
	}
}
