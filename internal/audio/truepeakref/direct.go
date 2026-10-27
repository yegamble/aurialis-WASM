package truepeakref

import "math"

// DirectHalfTaps is the half-length of DirectPeakDBTP's kernel.
const DirectHalfTaps = 1024

// DirectPeakDBTP is an independent time-domain cross-check: a ±1024-tap
// Kaiser-windowed sinc (beta 12) on a 32x grid, evaluated over the whole
// zero-extended signal, from DirectHalfTaps frames before the first frame to
// DirectHalfTaps frames after the last. It shares no code with PeakDBTP or
// the shipped meters, so edge behaviour (a file that starts or ends on a
// crest) is checked against a different algorithm. It is slow (about
// n·32·2048 multiply-adds per channel): use it on short fixtures.
func DirectPeakDBTP(channels [][]float32) float64 {
	const half, beta = DirectHalfTaps, 12.0
	bessel := func(v float64) float64 {
		sum, term := 1.0, 1.0
		for k := 1; k < 80; k++ {
			term *= v / 2 / float64(k)
			sum += term * term
		}
		return sum
	}
	// kernel[p][k] weights sample i+k-half+1 for t = i + p/Phases.
	kernel := make([][]float64, Phases)
	for p := range kernel {
		kernel[p] = make([]float64, 2*half)
		for k := range kernel[p] {
			d := float64(k-half+1) - float64(p)/Phases
			w := d / half
			sinc := 1.0
			if d != 0 {
				sinc = math.Sin(math.Pi*d) / (math.Pi * d)
			}
			kernel[p][k] = sinc * bessel(beta*math.Sqrt(math.Max(0, 1-w*w))) / bessel(beta)
		}
	}
	peak := 0.0
	for _, x := range channels {
		n := len(x)
		for i := -half; i < n+half; i++ {
			for p := range kernel {
				v := 0.0
				lo, hi := max(0, i-half+1), min(n-1, i+half)
				for j := lo; j <= hi; j++ {
					v += kernel[p][j-i+half-1] * float64(x[j])
				}
				peak = math.Max(peak, math.Abs(v))
			}
		}
	}
	if peak <= 0 {
		return math.Inf(-1)
	}
	return 20 * math.Log10(peak)
}
