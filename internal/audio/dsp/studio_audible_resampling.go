package dsp

import (
	"errors"
	"math"
)

const studioAudibleMaxTaps = 3073

// cspell:ignore Upsampler Downsampler

// This distinct private candidate intentionally rolls off above its declared
// audible passband. It does not inherit the old .49Fs-wideband contract. Actual
// response, alias, final-output and CPU qualification are required before use.
// No public Engine or version2 capability selects this candidate.
type studioAudibleKernel struct {
	rate, passHz, stopHz float64
	factor, taps, center int
	pairLatency          int
	full                 [studioAudibleMaxTaps]float64
	phases               [4][1024]float64
	counts               [4]int
}

func prepareStudioAudibleKernel(rate float64, factor int) (*studioAudibleKernel, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 || (factor != 2 && factor != 4) {
		return nil, errors.New("invalid private audible FIR layout")
	}
	pass, stop := math.Min(20000, .49*rate), rate*.5
	// Kaiser 100 dB design estimate plus 5% order margin. These preparation
	// choices require separate measured passband and stopband qualification.
	const beta = .1102 * (100 - 8.7)
	width := (stop - pass) / (float64(factor) * rate)
	order := 1.05 * (100 - 8) / (2.285 * 2 * math.Pi * width)
	length := 2*factor*int(math.Ceil(order/float64(2*factor))) + 1
	if length > studioAudibleMaxTaps || (length+factor-1)/factor > 1024 {
		return nil, errors.New("private audible FIR exceeds its fixed capacity")
	}
	c := &studioAudibleKernel{rate: rate, passHz: pass, stopHz: stop, factor: factor, taps: length, center: (length - 1) / 2, pairLatency: (length - 1) / factor}
	cutoff := (pass + stop) / (2 * float64(factor) * rate)
	denominator := studioBesselI0(beta)
	for tap := 0; tap <= c.center; tap++ {
		distance := float64(tap - c.center)
		value := 2 * cutoff
		if distance != 0 {
			value = math.Sin(2*math.Pi*cutoff*distance) / (math.Pi * distance)
		}
		position := distance / float64(c.center)
		value *= studioBesselI0(beta*math.Sqrt(math.Max(0, 1-position*position))) / denominator
		c.full[tap], c.full[length-1-tap] = value, value
	}
	var sums [4]float64
	for tap := 0; tap < length; tap++ {
		sums[tap%factor] += c.full[tap]
	}
	// Symmetric phase partners share normalization, preserving exact coefficient
	// symmetry while suppressing DC images. Every interpolation phase has unity
	// DC gain within floating-point summation precision.
	if factor == 4 {
		sums[1], sums[3] = (sums[1]+sums[3])/2, (sums[1]+sums[3])/2
	}
	for tap := 0; tap < length; tap++ {
		phase, cell := tap%factor, tap/factor
		c.full[tap] /= sums[phase] * float64(factor)
		c.phases[phase][cell] = c.full[tap] * float64(factor)
		c.counts[phase] = cell + 1
	}
	return c, nil
}

type studioAudibleUpsampler struct {
	history [2][1024]float64
	cursor  int
}

func (s *studioAudibleUpsampler) process(c *studioAudibleKernel, left, right float64) [4][2]float64 {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	s.history[0][s.cursor], s.history[1][s.cursor] = left, right
	var out [4][2]float64
	for phase := 0; phase < c.factor; phase++ {
		for ch := range s.history {
			sum := 0.0
			for tap, coefficient := range c.phases[phase][:c.counts[phase]] {
				sum += coefficient * s.history[ch][(s.cursor-tap)&1023]
			}
			out[phase][ch] = sum
		}
	}
	s.cursor = (s.cursor + 1) & 1023
	return out
}

type studioAudibleDownsampler struct {
	history [2][4096]float64
	cursor  int
}

func (s *studioAudibleDownsampler) process(c *studioAudibleKernel, input [4][2]float64) (float64, float64) {
	var out [2]float64
	for phase := 0; phase < c.factor; phase++ {
		for ch, value := range input[phase] {
			if !finite(value) {
				value = 0
			}
			s.history[ch][s.cursor] = value
		}
		if phase == 0 {
			for ch := range s.history {
				sum := c.full[c.center] * s.history[ch][(s.cursor-c.center)&4095]
				for tap, coefficient := range c.full[:c.center] {
					sum += coefficient * (s.history[ch][(s.cursor-tap)&4095] + s.history[ch][(s.cursor-c.taps+1+tap)&4095])
				}
				out[ch] = sum
			}
		}
		s.cursor = (s.cursor + 1) & 4095
	}
	return out[0], out[1]
}
