package dsp

import (
	"errors"
	"math"
)

const studioSaturationLatency = studioOversamplingLatency + 1

// This prepared candidate never runs from Engine algorithm 1. Its only supported
// nonlinear character initially is Tube; other models require separate state.
type studioSaturation struct {
	rate                         float64
	params                       SaturationParams
	filter                       studioHalfBandCoeffs
	oversampler                  [2]studioOversamplerState
	pad                          [2]studioHalfSamplePad
	dry                          [2][studioSaturationLatency]float64
	dryCursor                    int
	tube                         [2]studioADAAState
	curve                        studioTubeCurve
	dcInput, dcOutput            [2]float64
	dcPole                       float64
	mix, dcMix, fromMix, fromDC  float64
	transition, transitionLength int
}

func prepareStudioSaturation(rate float64, params SaturationParams) (studioSaturation, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 {
		return studioSaturation{}, errors.New("invalid studio saturation sample rate")
	}
	base := DefaultParams()
	base.Saturation = params
	if err := ValidateParams(base); err != nil {
		return studioSaturation{}, err
	}
	if params.Character != SatTube && params.Character != SatClean {
		return studioSaturation{}, errors.New("studio saturation character is not implemented")
	}
	s := studioSaturation{rate: rate, params: params, filter: prepareStudioHalfBand(), curve: prepareStudioTube(params.Amount), dcPole: math.Exp(-2 * math.Pi * 5 / rate)}
	s.mix, s.dcMix = s.targets()
	return s, nil
}

func (s *studioSaturation) targets() (float64, float64) {
	if !s.params.Enabled || s.params.Amount == 0 || s.params.Character == SatClean {
		return 0, 0
	}
	return s.params.Amount / 100, 1
}

// A prepared character has dedicated histories. Changing character requires a
// newly prepared graph; drive edits rebase the antiderivative without a spike.
func (s *studioSaturation) setParams(params SaturationParams) error {
	if params == s.params {
		return nil
	}
	if params.Character != s.params.Character {
		return errors.New("studio saturation character change requires preparation")
	}
	next, err := prepareStudioSaturation(s.rate, params)
	if err != nil {
		return err
	}
	s.params, s.curve = params, next.curve
	for ch := range s.tube {
		s.tube[ch].integral = s.curve.integral(s.tube[ch].input)
		s.tube[ch].integralValid = true
	}
	s.fromMix, s.fromDC = s.mix, s.dcMix
	s.transition, s.transitionLength = 0, int(math.Ceil(.005*s.rate))
	return nil
}

func (s *studioSaturation) resetHistory() {
	s.oversampler = [2]studioOversamplerState{}
	s.pad = [2]studioHalfSamplePad{}
	s.dry = [2][studioSaturationLatency]float64{}
	s.dryCursor = 0
	s.tube = [2]studioADAAState{}
	s.dcInput, s.dcOutput = [2]float64{}, [2]float64{}
	s.mix, s.dcMix = s.targets()
	s.transition, s.transitionLength = 0, 0
}

func (s *studioSaturation) process(left, right float64) (float64, float64) {
	targetMix, targetDC := s.targets()
	s.mix, s.dcMix = targetMix, targetDC
	if s.transitionLength > 0 {
		s.transition++
		fraction := float64(s.transition) / float64(s.transitionLength)
		s.mix = s.fromMix + fraction*(targetMix-s.fromMix)
		s.dcMix = s.fromDC + fraction*(targetDC-s.fromDC)
		if s.transition >= s.transitionLength {
			s.transition, s.transitionLength = 0, 0
		}
	}
	input, output := [2]float64{sanitizeSample(left), sanitizeSample(right)}, [2]float64{}
	for ch, sample := range input {
		dry := s.dry[ch][s.dryCursor]
		s.dry[ch][s.dryCursor] = sample
		subs := s.oversampler[ch].interpolate(&s.filter, sample)
		for index, value := range subs {
			shaped := s.tube[ch].process(value, s.curve)
			subs[index] = s.pad[ch].process(shaped)
		}
		wet := s.oversampler[ch].decimate(&s.filter, subs)
		mixed := (1-s.mix)*dry + s.mix*wet
		dc := sanitizeSample(mixed - s.dcInput[ch] + s.dcPole*s.dcOutput[ch])
		s.dcInput[ch], s.dcOutput[ch] = mixed, dc
		output[ch] = sanitizeSample((1-s.dcMix)*mixed + s.dcMix*dc)
	}
	s.dryCursor = (s.dryCursor + 1) % studioSaturationLatency
	return output[0], output[1]
}

// ADAA1 contributes 0.5 high-rate sample of small-signal delay. This symmetric
// 3.5-sample Lagrange pad makes their combined delay exactly four high-rate
// samples = one base frame. The pad has fixed scratch and no sample-time trig.
type studioHalfSamplePad struct {
	history [8]float64
	cursor  int
}

func (s *studioHalfSamplePad) process(input float64) float64 {
	coeffs := [8]float64{-.00244140625, .02392578125, -.11962890625, .59814453125, .59814453125, -.11962890625, .02392578125, -.00244140625}
	s.history[s.cursor] = input
	output := 0.0
	for tap, coefficient := range coeffs {
		output += coefficient * s.history[(s.cursor-tap)&7]
	}
	s.cursor = (s.cursor + 1) & 7
	return sanitizeSample(output)
}
