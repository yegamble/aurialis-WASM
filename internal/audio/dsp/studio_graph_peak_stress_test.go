//go:build studio_stress

package dsp

import (
	"math"
	"testing"
)

// This opt-in public-acceptance gate intentionally exposes an unresolved hard
// finite-record Nyquist failure. A green ordinary unit suite does not waive it.
// Run: go test -tags=studio_stress -run '^TestStudioGraphFiniteNyquistFinalOutput$' ./internal/audio/dsp
func TestStudioGraphFiniteNyquistFinalOutput(t *testing.T) {
	source := make([]float32, 2048)
	for i := range source {
		source[i] = 1.8
		if i%2 == 1 {
			source[i] = -1.8
		}
	}
	final := studioGraphFinalFloat(t, 48000, source)
	peak := 20 * math.Log10(studioIndependentPeak64(final))
	longer, time := studioIndependentReconstruction64(final, 16384)
	direct := 0.0
	for step := -64; step <= 64; step++ {
		direct = math.Max(direct, math.Abs(studioGraphDirectSinc(final, time+float64(step)/4096)))
	}
	t.Logf("known Nyquist stress short%.9f longer%.9f direct%.9f dBTP", peak, 20*math.Log10(longer), 20*math.Log10(direct))
	peak = math.Max(peak, math.Max(20*math.Log10(longer), 20*math.Log10(direct)))
	if peak > -.95 {
		t.Fatalf("OPEN: finite-Nyquist final float output %.9f dBTP exceeds -1 dBTP ceiling+.05; public algorithm2 remains blocked", peak)
	}
}
