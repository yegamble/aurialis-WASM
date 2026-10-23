package dsp

import "math"

// The limiter audio path uses the longer reconstruction family instead of the
// saturation oversampler. A beta 8 Kaiser window has a .49 Fs passband and .51 Fs
// stopband, measured in tests. Its group delay is 128 base frames per
// stage; the four interpolation phases each have unity DC gain.
// Gain processing belongs between these 4x interpolation/decimation stages.
const studioLimiterResamplingLatency = 2 * studioPeakHalf

type studioLimiterAudioKernel struct {
	quarter [256]float64
	half    [128]float64
}

func prepareStudioLimiterAudioKernel() studioLimiterAudioKernel {
	const beta = 8.0
	denominator := studioBesselI0(beta)
	kernel, quarterSum, halfSum := studioLimiterAudioKernel{}, 0.0, 0.0
	windowed := func(distance float64) float64 {
		position := distance / studioPeakHalf
		window := studioBesselI0(beta*math.Sqrt(math.Max(0, 1-position*position))) / denominator
		return math.Sin(math.Pi*distance) / (math.Pi * distance) * window
	}
	for tap := range kernel.quarter {
		kernel.quarter[tap] = windowed(float64(tap) + .25 - studioPeakHalf)
		quarterSum += kernel.quarter[tap]
	}
	for tap := range kernel.half {
		kernel.half[tap] = windowed(float64(tap) + .5 - studioPeakHalf)
		halfSum += 2 * kernel.half[tap]
	}
	for tap := range kernel.quarter {
		kernel.quarter[tap] /= quarterSum
	}
	for tap := range kernel.half {
		kernel.half[tap] /= halfSum
	}
	return kernel
}

type studioLimiterUpsampler struct {
	history [2][256]float64
	cursor  int
}

func (s *studioLimiterUpsampler) process(kernel *studioLimiterAudioKernel, left, right float64) [4][2]float64 {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	s.history[0][s.cursor], s.history[1][s.cursor] = left, right
	var output [4][2]float64
	for ch := range s.history {
		history := &s.history[ch]
		output[0][ch] = history[(s.cursor-studioPeakHalf)&255]
		quarter, half, threeQuarter := 0.0, 0.0, 0.0
		for tap, coefficient := range kernel.half {
			front, back := history[(s.cursor-tap)&255], history[(s.cursor-255+tap)&255]
			a, b := kernel.quarter[tap], kernel.quarter[255-tap]
			quarter += a*front + b*back
			threeQuarter += b*front + a*back
			half += coefficient * (front + back)
		}
		output[1][ch], output[2][ch], output[3][ch] = quarter, half, threeQuarter
	}
	s.cursor = (s.cursor + 1) & 255
	return output
}

type studioLimiterDownsampler struct {
	history [2][1024]float64
	cursor  int
}

func (s *studioLimiterDownsampler) process(kernel *studioLimiterAudioKernel, input [4][2]float64) (float64, float64) {
	var output [2]float64
	for phase, pair := range input {
		for ch, sample := range pair {
			s.history[ch][s.cursor] = sample
		}
		if phase == 0 {
			for ch := range s.history {
				history := &s.history[ch]
				sum := history[(s.cursor-4*studioPeakHalf)&1023]
				for tap, coefficient := range kernel.half {
					distance := 4 * tap
					sum += kernel.quarter[tap]*(history[(s.cursor-distance-1)&1023]+history[(s.cursor-1023+distance)&1023]) +
						kernel.quarter[255-tap]*(history[(s.cursor-distance-3)&1023]+history[(s.cursor-1021+distance)&1023]) +
						coefficient*(history[(s.cursor-distance-2)&1023]+history[(s.cursor-1022+distance)&1023])
				}
				output[ch] = sum * .25
			}
		}
		s.cursor = (s.cursor + 1) & 1023
	}
	return output[0], output[1]
}
