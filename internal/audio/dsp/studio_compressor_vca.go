package dsp

import "math"

type studioVCAState struct{ power, peak, crest, reduction float64 }
type studioVCACoeffs struct{ detector, peakRelease, crest, attack, release, autoFast, autoSlow float64 }

func prepareStudioVCA(rate float64, params CompressorParams) studioVCACoeffs {
	return studioVCACoeffs{detector: studioPole(rate, 5), peakRelease: studioPole(rate, 25), crest: studioPole(rate, 50), attack: studioPole(rate, params.AttackMS), release: studioPole(rate, params.ReleaseMS), autoFast: studioPole(rate, 60), autoSlow: studioPole(rate, 600)}
}

// The VCA candidate follows linked channel power rather than averaged amplitude.
// Crest memory selects fast recovery for sparse peaks and slow recovery for dense
// material. The 60–600 ms poles are engineering candidates, not hardware data.
func (s *studioVCAState) process(left, right float64, params CompressorParams, coeffs studioVCACoeffs) float64 {
	power := math.Max(left*left, right*right)
	s.power = sanitizeSample(coeffs.detector*s.power + (1-coeffs.detector)*power)
	peak := math.Sqrt(power)
	if peak >= s.peak {
		s.peak = peak
	} else {
		s.peak = sanitizeSample(coeffs.peakRelease*s.peak + (1-coeffs.peakRelease)*peak)
	}
	crest := math.Min(1, math.Max(0, 10*math.Log10(math.Max(s.peak*s.peak, 1e-24)/math.Max(s.power, 1e-24))/12))
	s.crest = sanitizeSample(coeffs.crest*s.crest + (1-coeffs.crest)*crest)
	target := studioSoftKnee(10*math.Log10(math.Max(s.power, 1e-24)), params)
	release := coeffs.release
	if params.AutoRelease {
		release = coeffs.autoSlow + s.crest*(coeffs.autoFast-coeffs.autoSlow)
	}
	if target > s.reduction {
		release = coeffs.attack
	}
	s.reduction = sanitizeSample(release*s.reduction + (1-release)*target)
	return s.reduction
}
