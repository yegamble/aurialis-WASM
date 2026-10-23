package dsp

import "math"

type studioFETState struct{ peak, reduction, memory float64 }
type studioFETCoeffs struct{ peakRelease, attack, release, autoFast, autoSlow, memory float64 }

func prepareStudioFET(rate float64, params CompressorParams) studioFETCoeffs {
	return studioFETCoeffs{peakRelease: studioPole(rate, .5), attack: studioPole(rate, .25*params.AttackMS), release: studioPole(rate, params.ReleaseMS), autoFast: studioPole(rate, 40), autoSlow: studioPole(rate, 250), memory: studioPole(rate, 80)}
}

// A bounded peak detector and quarter-scale attack distinguish this FET candidate
// from the other topologies. This mapping does not reproduce a hardware time range.
func (s *studioFETState) process(left, right float64, params CompressorParams, coeffs studioFETCoeffs) float64 {
	peak := studioExactMax(math.Abs(left), math.Abs(right))
	if peak >= s.peak {
		s.peak = peak
	} else {
		s.peak = sanitizeSample(coeffs.peakRelease*s.peak + (1-coeffs.peakRelease)*peak)
	}
	target := studioSoftKnee(linToDB(s.peak), params)
	s.memory = sanitizeSample(coeffs.memory*s.memory + (1-coeffs.memory)*studioExactMin(1, target/12))
	release := coeffs.release
	if params.AutoRelease {
		release = coeffs.autoFast + s.memory*(coeffs.autoSlow-coeffs.autoFast)
	}
	if target > s.reduction {
		release = coeffs.attack
	}
	s.reduction = sanitizeSample(release*s.reduction + (1-release)*target)
	return s.reduction
}
