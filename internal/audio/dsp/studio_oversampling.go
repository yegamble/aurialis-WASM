package dsp

import "math"

const (
	studioHalfBandTaps = 129
	studioOversampling = 4
	// Two 2x stages have 64 and 32 base-frame round-trip group delays.
	studioOversamplingLatency = 96
	studioOversamplingTail    = 192
)

// Every even tap except the 0.5 center is exactly zero. Both interpolation
// phases have unity DC gain after normalizing the 64 odd taps to sum to 0.5.
type studioHalfBandCoeffs struct{ odd [64]float64 }

func prepareStudioHalfBand() studioHalfBandCoeffs {
	const beta = 9.0
	denominator := studioBesselI0(beta)
	c, sum := studioHalfBandCoeffs{}, 0.0
	for k := range c.odd {
		n := 2*k + 1 - (studioHalfBandTaps-1)/2
		sign := 1.0
		if n&3 == 3 {
			sign = -1
		}
		position := float64(n) / 64
		window := studioBesselI0(beta*math.Sqrt(math.Max(0, 1-position*position))) / denominator
		c.odd[k] = sign * window / (math.Pi * float64(n))
		sum += c.odd[k]
	}
	for k := range c.odd {
		c.odd[k] *= .5 / sum
	}
	return c
}

func studioBesselI0(value float64) float64 {
	term, sum := 1.0, 1.0
	for n := 1; n < 64; n++ {
		term *= value * value / float64(4*n*n)
		sum += term
		if term < 1e-16*sum {
			break
		}
	}
	return sum
}

type studioUp2 struct {
	history [64]float64
	cursor  int
}

func (s *studioUp2) process(c *studioHalfBandCoeffs, input float64) (float64, float64) {
	s.history[s.cursor] = input
	even, odd := s.history[(s.cursor-32)&63], 0.0
	for k, coefficient := range c.odd[:32] {
		odd += 2 * coefficient * (s.history[(s.cursor-k)&63] + s.history[(s.cursor-63+k)&63])
	}
	s.cursor = (s.cursor + 1) & 63
	return even, odd
}

type studioDown2 struct {
	history [128]float64
	cursor  int
}

func (s *studioDown2) process(c *studioHalfBandCoeffs, even, odd float64) float64 {
	s.history[s.cursor] = even
	output := .5 * s.history[(s.cursor-64)&127]
	for k, coefficient := range c.odd[:32] {
		output += coefficient * (s.history[(s.cursor-2*k-1)&127] + s.history[(s.cursor-127+2*k)&127])
	}
	s.history[(s.cursor+1)&127] = odd
	s.cursor = (s.cursor + 2) & 127
	return sanitizeSample(output)
}

type studioOversamplerState struct {
	up   [2]studioUp2
	down [2]studioDown2
}

func (s *studioOversamplerState) interpolate(c *studioHalfBandCoeffs, input float64) [studioOversampling]float64 {
	a, b := s.up[0].process(c, input)
	p, q := s.up[1].process(c, a)
	r, v := s.up[1].process(c, b)
	return [studioOversampling]float64{p, q, r, v}
}

func (s *studioOversamplerState) decimate(c *studioHalfBandCoeffs, samples [studioOversampling]float64) float64 {
	a := s.down[1].process(c, samples[0], samples[1])
	b := s.down[1].process(c, samples[2], samples[3])
	return s.down[0].process(c, a, b)
}
