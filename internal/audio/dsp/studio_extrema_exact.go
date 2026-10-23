package dsp

import "math"

// These unselected private helpers preserve the original extrema functions for
// every tie or unordered pair. A strictly ordered pair returns the same selected
// operand without arithmetic. No graph or audio path currently uses them.
func studioExactMax(a, b float64) float64 {
	if a > b {
		return a
	}
	if b > a {
		return b
	}
	return math.Max(a, b)
}

func studioExactMin(a, b float64) float64 {
	if a < b {
		return a
	}
	if b < a {
		return b
	}
	return math.Min(a, b)
}
