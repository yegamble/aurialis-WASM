package dsp

import (
	"math"
	"testing"
)

// Frozen pre-optimization detector: independent old ring indexing, identical
// coefficients and summation order, retained to reject arithmetic drift.
type studioPostGuardDetectorReference struct {
	history     [2][1024]float64
	subs        [2][8]float64
	subCursor   int
	cursor      int
	frame       int64
	pendingPeak float64
}

func (s *studioPostGuardDetectorReference) process(kernel *studioPostGuardKernel, left, right float64) (int64, float64) {
	s.history[0][s.cursor], s.history[1][s.cursor] = left, right
	var samples [4][2]float64
	for ch := range s.history {
		samples[0][ch] = s.history[ch][(s.cursor-studioPostGuardHalf)&1023]
		quarter, half, threeQuarter := 0.0, 0.0, 0.0
		for tap, coefficient := range kernel.half {
			front, back := s.history[ch][(s.cursor-tap)&1023], s.history[ch][(s.cursor-1023+tap)&1023]
			a, b := kernel.quarter[tap], kernel.quarter[1023-tap]
			quarter += a*front + b*back
			threeQuarter += b*front + a*back
			half += coefficient * (front + back)
		}
		samples[1][ch], samples[2][ch], samples[3][ch] = quarter, half, threeQuarter
	}
	sealed := 0.0
	for phase, sample := range samples {
		cursor := s.subCursor
		for ch, value := range sample {
			history := &s.subs[ch]
			history[cursor] = value
			peak := studioRefinedPeak(history[(cursor-5)&7], history[(cursor-4)&7], history[(cursor-3)&7], history[(cursor-2)&7], history[(cursor-1)&7], value)
			s.pendingPeak = math.Max(s.pendingPeak, peak)
		}
		s.subCursor = (cursor + 1) & 7
		if phase == 2 {
			sealed = s.pendingPeak
			s.pendingPeak = 0
		}
	}
	index := s.frame - studioPostGuardAvailability
	s.frame++
	s.cursor = (s.cursor + 1) & 1023
	return index, sealed
}

func TestStudioPostDetectorMirroredHistoryMatchesFrozenRing(t *testing.T) {
	kernel := prepareStudioPostGuardKernel()
	var current studioPostGuardDetector
	var original studioPostGuardDetectorReference
	for i := range 16384 {
		left := .8*math.Sin(2*math.Pi*.49*float64(i)+.37) + .31*math.Cos(2*math.Pi*.123*float64(i))
		right := -.7*left + .25*math.Sin(2*math.Pi*.371*float64(i))
		if i%997 == 0 {
			left += 1.3
			right -= .9
		}
		if i > 12000 {
			left, right = 0, 0
		}
		a, p := current.process(&kernel, left, right)
		b, q := original.process(&kernel, left, right)
		if a != b || math.Float64bits(p) != math.Float64bits(q) {
			t.Fatalf("frame%d index%d/%d peak%.17g/%.17g", i, a, b, p, q)
		}
	}
}
