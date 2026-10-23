package dsp

import (
	"math"
	"math/cmplx"
)

// EQResponseAnchors returns preparation-only frequency probes around actual filter poles.
// It allocates and must never run in the audio callback. These anchors help numerical
// extremum searches resolve narrow resonances; they are not an all-frequency bound.
func EQResponseAnchors(sampleRate float64, bands [NumEQBands]BandParams) []float64 {
	anchors := make([]float64, 0, NumEQBands*17)
	for _, band := range bands {
		if !band.Enabled {
			continue
		}
		anchors = append(anchors, clampFreq(sampleRate, band.FreqHz))
		coeff := computeBandCoeffs(sampleRate, band)
		if !coeff.active {
			continue
		}
		a00, a01 := 2*coeff.a1-1, -2*coeff.a2
		a10, a11 := 2*coeff.a2, 1-2*coeff.a3
		trace := a00 + a11
		root := cmplx.Sqrt(complex(trace*trace-4*(a00*a11-a01*a10), 0))
		pole := (complex(trace, 0) + root) / 2
		radius := cmplx.Abs(pole)
		if radius <= 0 || radius >= 1 {
			continue
		}
		center := math.Abs(cmplx.Phase(pole)) * sampleRate / (2 * math.Pi)
		width := math.Max(1e-7, -math.Log(radius)*sampleRate/(2*math.Pi))
		anchors = append(anchors, center)
		for _, scale := range []float64{.125, .25, .5, 1, 2, 4, 8} {
			anchors = append(anchors, center-scale*width, center+scale*width)
		}
	}
	return anchors
}
