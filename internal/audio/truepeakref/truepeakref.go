// Package truepeakref is a test-only, near-ideal true-peak reference. It is
// deliberately slow and shares no code with the shipped detectors: tests use
// it to check that exports stay under the limiter ceiling and that the meters
// do not under-read. Production code must not import it.
//
// The reference is the band-limited (sinc) reconstruction of the whole
// zero-extended signal, evaluated on a 32x grid by shifting its spectrum: each
// grid phase is one inverse FFT. Unlike a finite windowed-sinc kernel, it does
// not attenuate content near Nyquist, so tones up to 0.498 fs read exactly.
package truepeakref

import (
	"math"
	"math/bits"
)

// Phases is the oversampling ratio of the reference grid. Its worst-case
// grid error, at Nyquist, is cos(pi/64): 0.005 dB.
const Phases = 32

// guard zero frames separate the signal's end from its periodic image, so the
// circular reconstruction matches the aperiodic one away from the edges.
const guard = 16384

// edgeSpan frames of the zero extension are measured on each side when edge
// is 0; it is well inside guard.
const edgeSpan = 1024

// PeakDBTP returns the highest absolute reconstructed value of any channel in
// dBTP. With edge 0 it measures the whole zero-extended file, edgeSpan frames
// before the first frame through edgeSpan after the last; a positive edge
// instead ignores that many frames at each end, where truncated test tones
// ring. Channels must have equal length.
func PeakDBTP(channels [][]float32, edge int) float64 {
	peak := 0.0
	for c := 0; c < len(channels); c += 2 {
		left := channels[c]
		right := left
		if c+1 < len(channels) {
			right = channels[c+1]
		}
		peak = math.Max(peak, pairPeak(left, right, edge))
	}
	if peak <= 0 {
		return math.Inf(-1)
	}
	return 20 * math.Log10(peak)
}

// pairPeak reconstructs two real channels at once as the real and imaginary
// parts of one complex signal.
func pairPeak(left, right []float32, edge int) float64 {
	n := len(left)
	if n == 0 || n <= 2*edge {
		return 0
	}
	size := 1 << bits.Len(uint(n+guard-1))
	spectrum := make([]complex128, size)
	for i := range left {
		spectrum[i] = complex(float64(left[i]), float64(right[i]))
	}
	f := newFFT(size)
	f.transform(spectrum, false)
	shifted := make([]complex128, size)
	peak := 0.0
	for p := 0; p < Phases; p++ {
		delay := float64(p) / Phases
		for k := range spectrum {
			signed := k
			if k > size/2 {
				signed = k - size
			}
			if k == size/2 {
				// Hermitian symmetry needs a real Nyquist factor.
				shifted[k] = spectrum[k] * complex(math.Cos(math.Pi*delay), 0)
				continue
			}
			angle := 2 * math.Pi * float64(signed) * delay / float64(size)
			shifted[k] = spectrum[k] * complex(math.Cos(angle), math.Sin(angle))
		}
		f.transform(shifted, true)
		// shifted[i] now holds x(i+delay) in its real (left) and imaginary
		// (right) parts.
		from, to := edge, n-edge
		if edge == 0 {
			// The zero extension rings before the first frame and after the
			// last; a file that starts or ends on a crest peaks there.
			from, to = -edgeSpan, n+edgeSpan
		}
		for i := from; i < to; i++ {
			v := shifted[(i+size)%size]
			peak = math.Max(peak, math.Max(math.Abs(real(v)), math.Abs(imag(v))))
		}
	}
	return peak
}

type fft struct {
	size    int
	twiddle []complex128
}

func newFFT(size int) fft {
	f := fft{size: size, twiddle: make([]complex128, size/2)}
	for k := range f.twiddle {
		angle := -2 * math.Pi * float64(k) / float64(size)
		f.twiddle[k] = complex(math.Cos(angle), math.Sin(angle))
	}
	return f
}

// transform is an in-place iterative radix-2 FFT; inverse scales by 1/size.
func (f fft) transform(x []complex128, inverse bool) {
	n := f.size
	for i, j := 1, 0; i < n; i++ {
		// j is i with its log2(n) bits reversed.
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
