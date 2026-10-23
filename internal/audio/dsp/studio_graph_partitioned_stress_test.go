//go:build studio_stress

package dsp

import (
	"math"
	"testing"
)

// The exact same hard cases, final N bytes, zero exterior, independent64x and
// direct-sinc probes and ceiling+.05 thresholds are used for BOTH candidates.
// This does not waive the separate historical Nyquist/ideal-sinc failures.
func TestStudioPartitionedGraphFiniteNyquistFinalOutput(t *testing.T) {
	testStudioAudibleGraphFiniteNyquistFinalOutput(t, mustStudioPartitionedAudibleGraph)
}

func TestStudioPartitionedGraphFiniteOutputStressCorpus(t *testing.T) {
	testStudioAudibleGraphFiniteOutputStressCorpus(t, mustStudioPartitionedAudibleGraph)
}

// Existing30cases remain unchanged. These extra in-band hot fixtures exercise
// the complete active prefix at high rates, where the old .173/.319Fs pair is
// intentionally above the distinct candidate's20kHz audio passband.
func TestStudioPartitionedGraphActiveAudibleBandFinalOutput(t *testing.T) {
	testStudioGraphActiveAudibleBandFinalOutput(t, mustStudioPartitionedAudibleGraph)
}

func testStudioGraphActiveAudibleBandFinalOutput(t *testing.T, factory studioAudibleGraphTestFactory) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for mode := range 2 {
			const count = 2048
			left, right := make([]float32, count), make([]float32, count)
			high := .97 * math.Min(20000, .49*rate)
			for i := range left {
				time := float64(i) / rate
				value := 1.1*math.Sin(2*math.Pi*high*time+.2) + .9*math.Sin(2*math.Pi*high*.731*time+.6)
				if mode == 1 {
					position := (float64(i) - float64(count)/2) / math.Max(1, rate*.00003)
					value += 2.4 * math.Exp(-position*position/2)
				}
				left[i], right[i] = float32(value), float32(-.7*value)
			}
			params := studioAudibleGraphActiveParams()
			params.Compressor.MakeupDB, params.DitherBits = 12, 24
			g := factory(t, rate, params, count, false)
			a, b := renderStudioGraph(t, g, left, right, 129)
			maximum := -1000.0
			for _, channel := range [][]float32{a[g.latency:], b[g.latency:]} {
				final := make([]float64, count)
				for i, sample := range channel {
					final[i] = float64(sample)
				}
				maximum = math.Max(maximum, 20*math.Log10(studioIndependentPeak64(final)))
			}
			t.Logf("rate%.0f active in-band mode%d exactN output%.9fdBTP", rate, mode, maximum)
			if maximum > -.95 {
				t.Errorf("OPEN: active in-band final output%.9fdBTP exceeds unchanged ceiling+.05", maximum)
			}
		}
	}
}
