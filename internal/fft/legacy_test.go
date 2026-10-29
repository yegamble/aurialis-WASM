package fft

import (
	"math"
	"math/cmplx"
)

// Frozen pre-consolidation arithmetic. These independent test-only loops guard
// bit patterns; do not refactor them to call the shared production transform.
type legacyDirectPlan struct {
	size    int
	twiddle []complex128
}

func newLegacyDirectPlan(size int) legacyDirectPlan {
	f := legacyDirectPlan{size: size, twiddle: make([]complex128, size/2)}
	for k := range f.twiddle {
		angle := -2 * math.Pi * float64(k) / float64(size)
		f.twiddle[k] = complex(math.Cos(angle), math.Sin(angle))
	}
	return f
}

// run transforms x in place; the inverse scales by 1/size.
func (f legacyDirectPlan) run(x []complex128, inverse bool) {
	n := f.size
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j |= bit
		if i < j {
			x[i], x[j] = x[j], x[i]
		}
	}
	for span := 1; span < n; span <<= 1 {
		stride := n / (2 * span)
		for start := 0; start < n; start += 2 * span {
			for k := 0; k < span; k++ {
				w := f.twiddle[k*stride]
				if inverse {
					w = complex(real(w), -imag(w))
				}
				a, b := x[start+k], x[start+k+span]*w
				x[start+k], x[start+k+span] = a+b, a-b
			}
		}
	}
	if inverse {
		scale := complex(1/float64(n), 0)
		for i := range x {
			x[i] *= scale
		}
	}
}

func legacyRecursive(values []complex128, inverse bool) {
	count := len(values)
	for i, j := 1, 0; i < count; i++ {
		bit := count >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for width := 2; width <= count; width <<= 1 {
		angle := -2 * math.Pi / float64(width)
		if inverse {
			angle = -angle
		}
		rotation := cmplx.Rect(1, angle)
		for first := 0; first < count; first += width {
			phase := complex(1, 0)
			for i := 0; i < width/2; i++ {
				a, b := values[first+i], values[first+i+width/2]*phase
				values[first+i], values[first+i+width/2] = a+b, a-b
				phase *= rotation
			}
		}
	}
	if inverse {
		for i := range values {
			values[i] /= complex(float64(count), 0)
		}
	}
}
