package dsp

import "math"

const (
	studioPostGuardHalf         = 512
	studioPostGuardAvailability = studioPostGuardHalf + 1
)

// This detector is distinct from the audio oversampling filter. A 4097-tap high-rate
// Hann sinc has a 512-base-frame center and three nontrivial 4x phases. Paired
// quarter phases and the symmetric half phase share one input-history pass.
// Steady-tone calibration through .49 cycles/base frame does not bound the
// ideal sinc peak of arbitrary finite records. A limiter using this detector
// still needs independent final-output reconstruction acceptance.
type studioPostGuardKernel struct {
	quarter [1024]float64
	half    [512]float64
}

func prepareStudioPostGuardKernel() studioPostGuardKernel {
	kernel, quarterSum, halfSum := studioPostGuardKernel{}, 0.0, 0.0
	for tap := range kernel.quarter {
		distance := float64(tap) + .25 - studioPostGuardHalf
		window := .5 - .5*math.Cos(2*math.Pi*(float64(tap)+.25)/(2*studioPostGuardHalf))
		kernel.quarter[tap] = math.Sin(math.Pi*distance) / (math.Pi * distance) * window
		quarterSum += kernel.quarter[tap]
	}
	for tap := range kernel.half {
		distance := float64(tap) + .5 - studioPostGuardHalf
		window := .5 - .5*math.Cos(2*math.Pi*(float64(tap)+.5)/(2*studioPostGuardHalf))
		kernel.half[tap] = math.Sin(math.Pi*distance) / (math.Pi * distance) * window
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

type studioPostGuardDetector struct {
	history     [2][2048]float64
	subs        [2][8]float64
	subCursor   int
	cursor      int
	frame       int64
	pendingPeak float64
}

func (s *studioPostGuardDetector) process(kernel *studioPostGuardKernel, left, right float64) (int64, float64) {
	s.history[0][s.cursor], s.history[1][s.cursor] = left, right
	s.history[0][s.cursor+1024], s.history[1][s.cursor+1024] = left, right
	var samples [4][2]float64
	for ch := range s.history {
		samples[0][ch] = s.history[ch][s.cursor+1024-studioPostGuardHalf]
		// Fixed-length views establish the bounds once per channel. The original
		// ring's arithmetic/summation order remains unchanged.
		frontHistory := (*[512]float64)(s.history[ch][s.cursor+513 : s.cursor+1025])
		backHistory := (*[512]float64)(s.history[ch][s.cursor+1 : s.cursor+513])
		quarter, half, threeQuarter := 0.0, 0.0, 0.0
		for tap, coefficient := range kernel.half {
			front, back := frontHistory[511-tap], backHistory[tap]
			a, b := kernel.quarter[tap], kernel.quarter[1023-tap]
			quarter += a*front + b*back
			threeQuarter += b*front + a*back
			half += coefficient * (front + back)
		}
		samples[1][ch], samples[2][ch], samples[3][ch] = quarter, half, threeQuarter
	}
	sealed := 0.0
	for phase, sample := range samples {
		cursor := s.subCursor
		for ch, value := range sample {
			history := &s.subs[ch]
			history[cursor] = value
			peak := studioRefinedPeak(history[(cursor-5)&7], history[(cursor-4)&7], history[(cursor-3)&7], history[(cursor-2)&7], history[(cursor-1)&7], value)
			s.pendingPeak = math.Max(s.pendingPeak, peak)
		}
		s.subCursor = (cursor + 1) & 7
		if phase == 2 {
			sealed = s.pendingPeak
			s.pendingPeak = 0
		}
	}
	index := s.frame - studioPostGuardAvailability
	s.frame++
	s.cursor = (s.cursor + 1) & 1023
	return index, sealed
}
