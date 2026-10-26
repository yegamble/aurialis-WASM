package dsp

import (
	"context"
	"errors"
	"math"
	"slices"
)

// ExportSampleRates lists the delivery rates an export may convert to.
var ExportSampleRates = []int{44100, 48000, 88200, 96000}

// IsExportSampleRate reports whether rate is a supported export conversion target.
func IsExportSampleRate(rate int) bool { return slices.Contains(ExportSampleRates, rate) }

const (
	resampleStopbandDB = 120.0
	// The passband stays flat to 90% of the lower Nyquist frequency (19.8 kHz
	// at 44.1 kHz) and is fully stopped at that Nyquist frequency.
	resamplePassband = 0.90
)

// resampler is a rational polyphase windowed-sinc converter. The prototype
// low-pass filter runs at from·up Hz and is decimated by down.
type resampler struct {
	up, down, taps int
	delay          int // Prototype group delay in up-rate samples.
	phases         [][]float64
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// besselI0 is the zeroth-order modified Bessel function used by the Kaiser window.
func besselI0(x float64) float64 {
	sum, term := 1.0, 1.0
	for k := 1.0; k < 64; k++ {
		term *= (x / (2 * k)) * (x / (2 * k))
		sum += term
		if term < sum*1e-17 {
			break
		}
	}
	return sum
}

func newResampler(from, to int) (*resampler, error) {
	if from < 8000 || from > 192000 || !IsExportSampleRate(to) {
		return nil, errors.New("unsupported sample-rate conversion")
	}
	g := gcd(from, to)
	up, down := to/g, from/g
	if up > 4096 || down > 4096 {
		return nil, errors.New("sample-rate ratio is too complex to convert exactly")
	}
	upRate := float64(from) * float64(up)
	nyquist := 0.5 * math.Min(float64(from), float64(to))
	transition := (1 - resamplePassband) * nyquist
	cutoff := (resamplePassband + 1) / 2 * nyquist
	// Standard Kaiser window design: beta and length from the attenuation.
	beta := 0.1102 * (resampleStopbandDB - 8.7)
	length := int(math.Ceil((resampleStopbandDB - 7.95) / (2.285 * 2 * math.Pi * transition / upRate)))
	taps := (length + up - 1) / up
	length = taps * up
	if length%2 == 0 {
		// An odd prototype has an integer group delay, so alignment is exact;
		// the dropped final coefficient stays zero.
		length--
	}
	center := float64(length-1) / 2
	norm := besselI0(beta)
	r := &resampler{up: up, down: down, taps: taps, delay: (length - 1) / 2, phases: make([][]float64, up)}
	for phase := range r.phases {
		r.phases[phase] = make([]float64, taps)
	}
	fc := cutoff / upRate // Cycles per up-rate sample.
	for n := range length {
		t := float64(n) - center
		sinc := 2 * fc
		if t != 0 {
			sinc = math.Sin(2*math.Pi*fc*t) / (math.Pi * t)
		}
		ratio := t / center
		window := besselI0(beta*math.Sqrt(math.Max(0, 1-ratio*ratio))) / norm
		// Gain up compensates for the zeros inserted between input samples.
		r.phases[n%up][n/up] = float64(up) * sinc * window
	}
	return r, nil
}

// process converts one channel. Output frame k sits at input time k·from/to,
// with the filter's group delay removed so the converted audio stays aligned.
func (r *resampler) process(ctx context.Context, in []float32, out []float32) error {
	for k := range out {
		if k%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		position := k*r.down + r.delay
		index, phase := position/r.up, position%r.up
		coefficients := r.phases[phase]
		var sum float64
		for j, c := range coefficients {
			i := index - j
			if i < 0 {
				break
			}
			if i < len(in) {
				// The conversion prevents fused multiply-adds, keeping native
				// and WebAssembly exports bit-identical.
				sum += float64(c * float64(in[i]))
			}
		}
		out[k] = finiteFloat32(sum)
	}
	return nil
}

// ResampleContext converts stereo audio from one rate to an export rate with a
// 120 dB Kaiser-windowed polyphase sinc filter, flat to 90% of the lower
// Nyquist frequency. The output keeps the source duration, rounded up to a whole frame.
func ResampleContext(ctx context.Context, left, right []float32, from, to int) ([]float32, []float32, error) {
	if len(left) != len(right) {
		return nil, nil, errors.New("resampling requires equal channel lengths")
	}
	r, err := newResampler(from, to)
	if err != nil {
		return nil, nil, err
	}
	frames := (len(left)*r.up + r.down - 1) / r.down
	outL, outR := make([]float32, frames), make([]float32, frames)
	if err := r.process(ctx, left, outL); err != nil {
		return nil, nil, err
	}
	if err := r.process(ctx, right, outR); err != nil {
		return nil, nil, err
	}
	return outL, outR, nil
}

// FinishResampled applies the export stages that must follow sample-rate
// conversion: the limiter's linked sample ceiling (when enabled) and TPDF
// dither for 16/24-bit output, keeping dithered samples on their grid.
func FinishResampled(left, right []float32, sampleRate float64, params Params) error {
	if err := ValidateParams(params); err != nil {
		return err
	}
	e := NewEngine(sampleRate)
	e.SetParams(params)
	limit := params.Limiter.Enabled && !params.Bypass
	scale := ditherScale(params.DitherBits)
	for i := range min(len(left), len(right)) {
		l, r := float64(left[i]), float64(right[i])
		if limit {
			ceiling := e.stages.limiterSampleCeiling
			if peak := math.Max(math.Abs(l), math.Abs(r)); peak > ceiling {
				l *= ceiling / peak
				r *= ceiling / peak
			}
		}
		if scale > 0 {
			l = e.applyTPDFDither(l, params.DitherBits)
			r = e.applyTPDFDither(r, params.DitherBits)
			if limit {
				// The largest grid value under the ceiling replaces a dithered over.
				top := math.Floor(e.stages.limiterSampleCeiling*scale) / scale
				if math.Abs(l) > top {
					l = math.Copysign(top, l)
				}
				if math.Abs(r) > top {
					r = math.Copysign(top, r)
				}
			}
		}
		left[i], right[i] = finiteFloat32(l), finiteFloat32(r)
	}
	return nil
}
