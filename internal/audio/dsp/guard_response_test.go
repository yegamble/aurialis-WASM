package dsp

import (
	"fmt"
	"math"
	"math/cmplx"
	"testing"
)

// guardResponseDB evaluates the Nyquist guard's magnitude at frequency hz.
func guardResponseDB(hz, rate float64) float64 {
	z := cmplx.Exp(complex(0, -2*math.Pi*hz/rate)) // z^-1
	h := complex(1, 0)
	for _, c := range nyquistGuardSections {
		num := complex(c[0], 0) + complex(c[1], 0)*z + complex(c[2], 0)*z*z
		den := 1 + complex(c[3], 0)*z + complex(c[4], 0)*z*z
		h *= num / den
	}
	return 20 * math.Log10(cmplx.Abs(h))
}

// V1-13 Round E S3: the guard is flat to 0.45 fs (ripple at most 0.02 dB,
// 19.85 kHz at 44.1 kHz) and at least 69.98 dB down from 0.4643 fs to Nyquist
// (the elliptic stopband is equiripple at -70 dB, -69.99 after the unity-DC
// scaling).
// An impulse through the streaming filter confirms the coefficients the
// engine runs match the analytic response.
func TestNyquistGuardResponse(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		t.Run(fmt.Sprintf("%.0f", rate), func(t *testing.T) {
			lowest, highest, stop := math.Inf(1), math.Inf(-1), math.Inf(-1)
			for i := 0; i <= 4000; i++ {
				hz := 0.45 * rate * float64(i) / 4000
				db := guardResponseDB(hz, rate)
				lowest, highest = math.Min(lowest, db), math.Max(highest, db)
			}
			for i := 0; i <= 2000; i++ {
				hz := rate * (0.4643 + 0.0357*float64(i)/2000)
				stop = math.Max(stop, guardResponseDB(hz, rate))
			}
			t.Logf("passband %+.4f…%+.4f dB to %.0f Hz, stopband max %.1f dB from %.0f Hz", lowest, highest, 0.45*rate, stop, 0.4643*rate)
			if highest-lowest > 0.02 || math.Abs(guardResponseDB(0, rate)) > 1e-9 {
				t.Errorf("passband ripple %.4f dB (DC %.2e dB)", highest-lowest, guardResponseDB(0, rate))
			}
			if stop > -69.98 {
				t.Errorf("stopband reaches %.1f dB", stop)
			}
		})
	}
	// The streaming filter's steady-state gain at 1 and 21 kHz (48 kHz rate).
	for _, hz := range []float64{1000, 21000} {
		var g nyquistGuard
		var in, out float64
		for i := 0; i < 48000; i++ {
			x := math.Sin(2 * math.Pi * hz * float64(i) / 48000)
			y, _ := g.sample(x, 0)
			if i >= 24000 {
				in, out = in+x*x, out+y*y
			}
		}
		if got, want := 10*math.Log10(out/in), guardResponseDB(hz, 48000); math.Abs(got-want) > 0.001 {
			t.Fatalf("streaming %.0f Hz gain %.4f dB, analytic %.4f dB", hz, got, want)
		}
	}
}
