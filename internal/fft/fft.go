// Package fft implements prepared in-place radix-2 complex transforms.
package fft

import (
	"math"
	"math/bits"
	"math/cmplx"
)

// TwiddleStrategy selects the established root and normalization conventions.
type TwiddleStrategy uint8

const (
	// DirectTwiddles evaluates every root directly and multiplies by 1/N on inverse.
	DirectTwiddles TwiddleStrategy = iota
	// RecursiveTwiddles prepares roots by stage recurrence and divides by N on inverse.
	// Shared arithmetic can differ from the former standalone loop by roundoff;
	// compatibility is bounded by 5e-15 times max(1, output peak) in the fixtures.
	RecursiveTwiddles
)

type stage struct{ span, offset, stride int }

// Plan is immutable after construction and safe to share across independent
// workspaces. Transform never allocates; callers own their transformed samples.
type Plan struct {
	size             int
	strategy         TwiddleStrategy
	forward, inverse []complex128
	stages           []stage
}

// New prepares a plan for a positive power-of-two size. Invalid geometry or an
// unknown strategy is a programming error. Callers bound workspace size before
// construction; there is no process-wide cache or retained source audio.
func New(size int, strategy TwiddleStrategy) Plan {
	if size < 1 || size&(size-1) != 0 {
		panic("FFT size must be a positive power of two")
	}
	if strategy != DirectTwiddles && strategy != RecursiveTwiddles {
		panic("unknown FFT twiddle strategy")
	}
	plan := Plan{size: size, strategy: strategy, stages: make([]stage, 0, bits.Len(uint(size))-1)}
	if strategy == DirectTwiddles {
		plan.forward = make([]complex128, size/2)
		plan.inverse = make([]complex128, size/2)
		for k := range plan.forward {
			angle := -2 * math.Pi * float64(k) / float64(size)
			root := complex(math.Cos(angle), math.Sin(angle))
			plan.forward[k] = root
			plan.inverse[k] = complex(real(root), -imag(root))
		}
	} else {
		plan.forward = make([]complex128, 0, size-1)
		plan.inverse = make([]complex128, 0, size-1)
	}
	for span := 1; span < size; span *= 2 {
		next := stage{span: span, stride: size / (2 * span)}
		if strategy == RecursiveTwiddles {
			next.offset = len(plan.forward)
			next.stride = 1
			angle := -2 * math.Pi / float64(2*span)
			rotation, reverse := cmplx.Rect(1, angle), cmplx.Rect(1, -angle)
			phase, inverse := complex(1, 0), complex(1, 0)
			for range span {
				plan.forward = append(plan.forward, phase)
				plan.inverse = append(plan.inverse, inverse)
				phase *= rotation
				inverse *= reverse
			}
		}
		plan.stages = append(plan.stages, next)
	}
	return plan
}

// Transform applies the forward transform or the normalized inverse in place.
// A length different from the prepared size is a programming error.
func (plan Plan) Transform(values []complex128, inverse bool) {
	if len(values) != plan.size {
		panic("FFT workspace length differs from plan")
	}
	for i, j := 1, 0; i < plan.size; i++ {
		bit := plan.size >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	weights := plan.forward
	if inverse {
		weights = plan.inverse
	}
	for _, stage := range plan.stages {
		roots := weights[stage.offset:]
		for start := 0; start < plan.size; start += 2 * stage.span {
			for k := 0; k < stage.span; k++ {
				even, odd := values[start+k], values[start+k+stage.span]*roots[k*stage.stride]
				values[start+k], values[start+k+stage.span] = even+odd, even-odd
			}
		}
	}
	if inverse {
		if plan.strategy == DirectTwiddles {
			scale := complex(1/float64(plan.size), 0)
			for i := range values {
				values[i] *= scale
			}
		} else {
			for i := range values {
				values[i] /= complex(float64(plan.size), 0)
			}
		}
	}
}
