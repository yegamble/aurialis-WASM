package dsp

import "math"

type studioOpticalState struct{ peak, fastGR, slowGR, exposure float64 }
type studioOpticalCoeffs struct{ peakRelease, attack, release, slowAttack, slowMinimum, slowMaximum, exposure float64 }

func prepareStudioOptical(rate float64, params CompressorParams) studioOpticalCoeffs {
	release := params.ReleaseMS
	if params.AutoRelease {
		release = 60
	}
	return studioOpticalCoeffs{
		peakRelease: studioPole(rate, 5), attack: studioPole(rate, params.AttackMS),
		release: studioPole(rate, release), slowAttack: studioPole(rate, 350),
		slowMinimum: studioPole(rate, 500), slowMaximum: studioPole(rate, 3500),
		exposure: studioPole(rate, 1200),
	}
}

func (s *studioOpticalState) process(left, right float64, params CompressorParams, coeffs studioOpticalCoeffs) float64 {
	peak := math.Max(math.Abs(left), math.Abs(right))
	if peak >= s.peak {
		s.peak = peak
	} else {
		s.peak = sanitizeSample(coeffs.peakRelease*s.peak + (1-coeffs.peakRelease)*peak)
	}
	target := studioSoftKnee(linToDB(s.peak), params)
	exposure := math.Min(1, target/12)
	s.exposure = sanitizeSample(coeffs.exposure*s.exposure + (1-coeffs.exposure)*exposure)
	fast := coeffs.release
	if target > s.fastGR {
		fast = coeffs.attack
	}
	s.fastGR = sanitizeSample(fast*s.fastGR + (1-fast)*target)
	// Slow exposure and reduction are independent states. Varying a coefficient
	// on one envelope alone would not create a second recovery stage.
	slow := coeffs.slowMinimum + s.exposure*(coeffs.slowMaximum-coeffs.slowMinimum)
	if target > s.slowGR {
		slow = coeffs.slowAttack
	}
	s.slowGR = sanitizeSample(slow*s.slowGR + (1-slow)*target)
	return math.Max(s.fastGR, s.exposure*s.slowGR)
}
