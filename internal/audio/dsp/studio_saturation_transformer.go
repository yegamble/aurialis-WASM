package dsp

import "math"

type studioTransformerState struct {
	flux, previousInput  float64
	saturated, reference studioADAAState
}

type studioTransformerCoeffs struct {
	fluxPole, contribution float64
	curve, referenceCurve  studioTubeCurve
}

func prepareStudioTransformer(rate, amount float64) studioTransformerCoeffs {
	fraction := amount / 100
	return studioTransformerCoeffs{
		fluxPole: math.Exp(-2 * math.Pi * 35 / (rate * studioOversampling)), contribution: .4 * fraction,
		curve: studioTubeCurve{drive: 1 + 3*fraction, normalizer: 1 + 3*fraction}, referenceCurve: studioTubeCurve{drive: 1, normalizer: 1},
	}
}

// This leaky 35 Hz flux proxy supplies memory without claiming a magnetic B-H
// loop. The difference of two bounded transfers is globally bounded; subtracting
// their matching small-signal terms preserves the gain of the linear path.
func (s *studioTransformerState) process(input float64, coeffs studioTransformerCoeffs) float64 {
	s.flux = sanitizeSample(coeffs.fluxPole*s.flux + (1-coeffs.fluxPole)*input)
	saturated := s.saturated.process(s.flux, coeffs.curve)
	reference := s.reference.process(s.flux, coeffs.referenceCurve)
	linear := .5 * (input + s.previousInput)
	s.previousInput = input
	return sanitizeSample(linear + coeffs.contribution*(saturated-reference))
}
