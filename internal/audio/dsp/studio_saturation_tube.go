package dsp

import "math"

type studioTubeCurve struct{ drive, bias, biasValue, normalizer, integralAtZero float64 }

func prepareStudioTube(amount float64) studioTubeCurve {
	drive, bias := 1+3.5*amount/100, .16*amount/100
	value := math.Tanh(bias)
	return studioTubeCurve{drive: drive, bias: bias, biasValue: value, normalizer: drive * (1 - value*value), integralAtZero: studioLogCosh(bias)}
}

func studioLogCosh(value float64) float64 {
	magnitude := math.Abs(value)
	return magnitude + math.Log1p(math.Exp(-2*magnitude)) - math.Ln2
}

func (c studioTubeCurve) value(input float64) float64 {
	return (math.Tanh(c.drive*input+c.bias) - c.biasValue) / c.normalizer
}

func (c studioTubeCurve) integral(input float64) float64 {
	return (studioLogCosh(c.drive*input+c.bias) - c.integralAtZero - c.drive*c.biasValue*input) / (c.drive * c.normalizer)
}

type studioADAAState struct {
	input, integral float64
	integralValid   bool
}

func (s *studioADAAState) process(input float64, curve studioTubeCurve) float64 {
	delta := input - s.input
	output := 0.0
	if math.Abs(delta) <= 1e-5*(1+math.Abs(input)+math.Abs(s.input)) {
		// Preserve the half-sample limit without expensive integral evaluations
		// on constant values. Mark changed history for lazy evaluation later.
		output = curve.value(.5 * (input + s.input))
		if input != s.input {
			s.integralValid = false
		}
	} else {
		previous := s.integral
		if !s.integralValid {
			previous = curve.integral(s.input)
		}
		integral := curve.integral(input)
		output = (integral - previous) / delta
		s.integral, s.integralValid = integral, true
	}
	s.input = input
	return sanitizeSample(output)
}
