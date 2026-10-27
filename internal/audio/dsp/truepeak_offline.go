package dsp

import (
	"context"
	"math"
	"math/bits"
)

// Offline true-peak geometry (V1-13 Round E R5). The export report and
// Release Check measure whole files with no real-time budget, so they
// reconstruct by spectral shift instead of a finite FIR: each block plus a
// guard of neighboring frames on both sides is transformed once, and every
// grid phase is one inverse transform. Content up to Nyquist reads exactly
// except for what lies beyond the guard; a parabola then refines the 4x grid.
const (
	offlinePeakPhases = 4
	offlinePeakSize   = 1 << 16 // transform length
	offlinePeakGuard  = 1 << 13 // frames of context on each side
	// Each transform measures offlinePeakSize - 2*offlinePeakGuard = 49152 frames.
	// offlinePeakEdge frames of the zero extension are measured before the
	// first frame and after the last: a file that starts or ends on a crest
	// rings there, and its true peak can lie past the last frame. Starting
	// before the file also gives the first parabola real neighbors, not
	// zeros (a lone 0.9 sample once read -0.15 dBTP instead of -0.92).
	offlinePeakEdge = 1 << 10
)

// offlineTruePeak returns the highest reconstructed absolute value of either
// channel of the zero-extended file, evaluated on a 4x grid from
// offlinePeakEdge frames before the first frame to offlinePeakEdge frames
// after the last. It checks ctx once per block.
func offlineTruePeak(ctx context.Context, left, right []float32) (float64, error) {
	n := min(len(left), len(right))
	if n == 0 {
		return 0, nil
	}
	// Measured frames run from -offlinePeakEdge to n+offlinePeakEdge-1.
	first, end := -offlinePeakEdge, n+offlinePeakEdge
	size := offlinePeakSize
	if end-first+2*offlinePeakGuard < size {
		// A short file fits one transform; shrink it to the next power of two.
		size = 1 << bits.Len(uint(end-first+2*offlinePeakGuard-1))
	}
	block := size - 2*offlinePeakGuard
	transform := newPeakFFT(size)
	// rotation[p-1][k] delays phase p by p/M samples at bin k (0..size/2).
	var rotation [offlinePeakPhases - 1][]complex128
	for p := range rotation {
		rotation[p] = make([]complex128, size/2+1)
		for k := range rotation[p] {
			angle := 2 * math.Pi * float64(k) * float64(p+1) / offlinePeakPhases / float64(size)
			rotation[p][k] = complex(math.Cos(angle), math.Sin(angle))
		}
		// Hermitian symmetry needs a real Nyquist factor.
		rotation[p][size/2] = complex(math.Cos(math.Pi*float64(p+1)/offlinePeakPhases), 0)
	}
	spectrum, shifted := make([]complex128, size), make([]complex128, size)
	phases := make([][]complex128, offlinePeakPhases-1)
	for p := range phases {
		phases[p] = make([]complex128, block)
	}
	var grid [2][2]float64 // previous two grid values per channel, oldest first
	peak := 0.0
	sample := func(at int) complex128 {
		if at < 0 || at >= n {
			return 0
		}
		return complex(sanitizeSample(float64(left[at])), sanitizeSample(float64(right[at])))
	}
	for start := first; start < end; start += block {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		for i := range spectrum {
			spectrum[i] = sample(start - offlinePeakGuard + i)
		}
		transform.run(spectrum, false)
		for p := range phases {
			rotate := rotation[p]
			for k := range spectrum {
				switch {
				case k <= size/2:
					shifted[k] = spectrum[k] * rotate[k]
				default:
					r := rotate[size-k]
					shifted[k] = spectrum[k] * complex(real(r), -imag(r))
				}
			}
			transform.run(shifted, true)
			copy(phases[p], shifted[offlinePeakGuard:offlinePeakGuard+block])
		}
		for i := 0; i < block && start+i < end; i++ {
			values := [offlinePeakPhases]complex128{sample(start + i)}
			for p := range phases {
				values[p+1] = phases[p][i]
			}
			for _, v := range values {
				for channel, value := range [2]float64{real(v), imag(v)} {
					g := &grid[channel]
					peak = math.Max(peak, refinePeak(g[0], g[1], value))
					g[0], g[1] = g[1], value
				}
			}
		}
	}
	for channel := range grid {
		// The last grid value has no successor inside the measured span.
		peak = math.Max(peak, math.Abs(grid[channel][1]))
	}
	return peak, nil
}

// peakFFT is an in-place iterative radix-2 transform for offlineTruePeak.
type peakFFT struct {
	size    int
	twiddle []complex128
}

func newPeakFFT(size int) peakFFT {
	f := peakFFT{size: size, twiddle: make([]complex128, size/2)}
	for k := range f.twiddle {
		angle := -2 * math.Pi * float64(k) / float64(size)
		f.twiddle[k] = complex(math.Cos(angle), math.Sin(angle))
	}
	return f
}

// run transforms x in place; the inverse scales by 1/size.
func (f peakFFT) run(x []complex128, inverse bool) {
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
