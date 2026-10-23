package dsp

import "math"

type studioMuState struct{ detector, reduction, memory float64 }
type studioMuCoeffs struct{ detector, attack, release, autoFast, autoSlow, memory float64 }

func prepareStudioMu(rate float64, params CompressorParams) studioMuCoeffs {
	return studioMuCoeffs{detector: studioPole(rate, 2), attack: studioPole(rate, params.AttackMS), release: studioPole(rate, params.ReleaseMS), autoFast: studioPole(rate, 80), autoSlow: studioPole(rate, 1000), memory: studioPole(rate, 500)}
}

// This original progressive curve retains an explicit threshold. Knee sets the
// span over which the ratio grows towards its requested asymptote, not a circuit.
func studioMuReduction(levelDB float64, params CompressorParams) float64 {
	if params.Ratio == 1 {
		return 0
	}
	distance := studioExactMax(0, levelDB-(params.ThresholdDB-params.KneeDB))
	if distance == 0 {
		return 0
	}
	ratio := params.Ratio
	if params.KneeDB > 0 {
		ratio = 1 + (params.Ratio-1)*distance/(distance+params.KneeDB)
	}
	return distance * (1 - 1/ratio)
}

func (s *studioMuState) process(left, right float64, params CompressorParams, coeffs studioMuCoeffs) float64 {
	rectified := studioExactMax(math.Abs(left), math.Abs(right))
	s.detector = sanitizeSample(coeffs.detector*s.detector + (1-coeffs.detector)*rectified)
	target := studioMuReduction(linToDB(s.detector), params)
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
