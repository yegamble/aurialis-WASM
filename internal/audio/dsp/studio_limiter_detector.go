package dsp

import "math"

const (
	studioPeakHalf         = 128
	studioPeakAvailability = studioPeakHalf + 1
)

// This detector is distinct from the audio oversampler. A 1025-tap high-rate
// Hann sinc has a 128-base-frame center and three nontrivial 4x phases. Paired
// quarter phases and the symmetric half phase share one input-history pass.
type studioPeakKernel struct {
	quarter [256]float64
	half    [128]float64
}

func prepareStudioPeakKernel() studioPeakKernel {
	kernel, quarterSum, halfSum := studioPeakKernel{}, 0.0, 0.0
	for tap := range kernel.quarter {
		distance := float64(tap) + .25 - studioPeakHalf
		window := .5 - .5*math.Cos(2*math.Pi*(float64(tap)+.25)/(2*studioPeakHalf))
		kernel.quarter[tap] = math.Sin(math.Pi*distance) / (math.Pi * distance) * window
		quarterSum += kernel.quarter[tap]
	}
	for tap := range kernel.half {
		distance := float64(tap) + .5 - studioPeakHalf
		window := .5 - .5*math.Cos(2*math.Pi*(float64(tap)+.5)/(2*studioPeakHalf))
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

type studioPeakDetector struct {
	history     [2][256]float64
	subs        [2][8]float64
	subCursor   int
	cursor      int
	frame       int64
	pendingPeak float64
}

func (s *studioPeakDetector) process(kernel *studioPeakKernel, left, right float64) (int64, float64) {
	s.history[0][s.cursor], s.history[1][s.cursor] = left, right
	var samples [4][2]float64
	for ch := range s.history {
		samples[0][ch] = s.history[ch][(s.cursor-studioPeakHalf)&255]
		quarter, half, threeQuarter := 0.0, 0.0, 0.0
		for tap, coefficient := range kernel.half {
			front, back := s.history[ch][(s.cursor-tap)&255], s.history[ch][(s.cursor-255+tap)&255]
			a, b := kernel.quarter[tap], kernel.quarter[255-tap]
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
	index := s.frame - studioPeakAvailability
	s.frame++
	s.cursor = (s.cursor + 1) & 255
	return index, sealed
}

// Six-point interpolation avoids the measured cubic amplitude loss near
// Nyquist. Cubic stationary points seed bounded quintic Newton refinement.
// The detector's accuracy remains subject to independent analytic/output tests.
func studioRefinedPeak(previous2, previous1, first, second, next1, next2 float64) float64 {
	s0, s1, s2 := first+second, previous1+next1, previous2+next2
	d0, d1, d2 := second-first, next1-previous1, next2-previous2
	a0 := 75.0/128*s0 - 25.0/256*s1 + 3.0/256*s2
	a2 := -17.0/48*s0 + 13.0/32*s1 - 5.0/96*s2
	a4 := 1.0/24*s0 - 1.0/16*s1 + 1.0/48*s2
	a1 := 75.0/64*d0 - 25.0/384*d1 + 3.0/640*d2
	a3 := -17.0/24*d0 + 13.0/48*d1 - 1.0/48*d2
	a5 := 1.0/12*d0 - 1.0/24*d1 + 1.0/120*d2
	peak := math.Max(math.Abs(first), math.Abs(second))
	refine := func(position float64) {
		u := position - .5
		for range 2 {
			derivative := (((5*a5*u+4*a4)*u+3*a3)*u+2*a2)*u + a1
			curvature := ((20*a5*u+12*a4)*u+6*a3)*u + 2*a2
			if math.Abs(curvature) < 1e-15 {
				break
			}
			next := u - derivative/curvature
			if next < -.5 || next > .5 {
				break
			}
			u = next
		}
		value := ((((a5*u+a4)*u+a3)*u+a2)*u+a1)*u + a0
		peak = math.Max(peak, math.Abs(value))
	}
	refine(.5)
	a := -.5*previous1 + 1.5*first - 1.5*second + .5*next1
	b := previous1 - 2.5*first + 2*second - .5*next1
	c := -.5*previous1 + .5*second
	visit := func(position float64) {
		if position > 0 && position < 1 {
			refine(position)
		}
	}
	if math.Abs(a) < 1e-15 {
		if math.Abs(b) > 1e-15 {
			visit(-c / (2 * b))
		}
	} else {
		discriminant := 4*b*b - 12*a*c
		if discriminant >= 0 {
			root := math.Sqrt(discriminant)
			visit((-2*b + root) / (6 * a))
			visit((-2*b - root) / (6 * a))
		}
	}
	return peak
}
