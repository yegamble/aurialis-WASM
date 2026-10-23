package dsp

import "math"

type studioTapeState struct {
	head                 svfState
	highFrequency, power float64
	adaa                 studioADAAState
}

type studioTapeCoeffs struct {
	head                                             svfCoeffs
	headBoost, highFrequencyPole, powerPole, damping float64
	curve                                            studioTubeCurve
}

func prepareStudioTape(rate, amount float64) studioTapeCoeffs {
	fraction, highRate := amount/100, rate*studioOversampling
	return studioTapeCoeffs{
		head: computeBandpassSVF(highRate, 55, .65), headBoost: (dbToLin(1.5*fraction) - 1) / .65,
		highFrequencyPole: math.Exp(-2 * math.Pi * math.Min(12000, .4*rate) / highRate), powerPole: studioPole(highRate, 2), damping: .35 * fraction,
		curve: studioTubeCurve{drive: 1 + 3*fraction, normalizer: 1 + 3*fraction},
	}
}

// The fixed response candidate has a broad 55 Hz/Q.65 head bump up to 1.5 dB
// and power-dependent HF damping. It specifies no tape speed or machine model.
func (s *studioTapeState) process(input float64, coeffs studioTapeCoeffs) float64 {
	band := processSVF(coeffs.head, &s.head, input)
	head := input + coeffs.headBoost*band
	s.highFrequency = sanitizeSample(coeffs.highFrequencyPole*s.highFrequency + (1-coeffs.highFrequencyPole)*head)
	s.power = sanitizeSample(coeffs.powerPole*s.power + (1-coeffs.powerPole)*head*head)
	density := s.power / (s.power + .25)
	shaped := head - coeffs.damping*density*(head-s.highFrequency)
	return s.adaa.process(shaped, coeffs.curve)
}
