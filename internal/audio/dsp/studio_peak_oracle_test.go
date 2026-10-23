package dsp

import (
	"math"
	"testing"
)

// This test-only oracle shares no production detector FIR or polynomial. It
// reconstructs a zero-padded record by splitting the Nyquist bin and inserting
// zero frequency bins, then evaluates the inverse DFT on a 64x time grid. The
// periodic boundary has at least 512 explicit zero samples on either side.
// It is an independent final-output probe, not proof of all-frequency accuracy
// or a substitute for the official EBU/ITU conformance material.
func studioIndependentPeak64(samples []float64) float64 {
	const padding = 512
	count := 1
	for count < len(samples)+2*padding {
		count *= 2
	}
	base := make([]complex128, count)
	for i, value := range samples {
		base[padding+i] = complex(value, 0)
	}
	studioTestFFT(base, false)
	oversampled := make([]complex128, count*64)
	oversampled[0] = base[0] * 64
	for bin := 1; bin < count/2; bin++ {
		oversampled[bin] = base[bin] * 64
		oversampled[len(oversampled)-bin] = base[count-bin] * 64
	}
	oversampled[count/2], oversampled[len(oversampled)-count/2] = base[count/2]*32, base[count/2]*32
	studioTestFFT(oversampled, true)
	maximum := 0.0
	for _, value := range oversampled {
		maximum = math.Max(maximum, math.Abs(real(value)))
	}
	return maximum
}

func studioTestFFT(values []complex128, inverse bool) {
	for i, j := 1, 0; i < len(values); i++ {
		bit := len(values) >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for length := 2; length <= len(values); length *= 2 {
		angle := -2 * math.Pi / float64(length)
		if inverse {
			angle = -angle
		}
		root := complex(math.Cos(angle), math.Sin(angle))
		for start := 0; start < len(values); start += length {
			weight := complex(1, 0)
			for offset := 0; offset < length/2; offset++ {
				a, b := values[start+offset], weight*values[start+offset+length/2]
				values[start+offset], values[start+offset+length/2] = a+b, a-b
				weight *= root
			}
		}
	}
	if inverse {
		for i := range values {
			values[i] /= complex(float64(len(values)), 0)
		}
	}
}

func TestStudioIndependentPeakOracleAnalyticCases(t *testing.T) {
	if got := studioIndependentPeak64([]float64{1}); math.Abs(got-1) > 1e-9 {
		t.Fatalf("independent impulse peak %g differs from unity", got)
	}
	if got := studioIndependentPeak64([]float64{1, 1}); math.Abs(got-4/math.Pi) > 1e-5 {
		t.Fatalf("independent adjacent-sample peak %g expected 4/pi", got)
	}
	if got := studioIndependentPeak64(nil); got != 0 {
		t.Fatal("silent oracle acquired a peak")
	}
	source := []float64{.3, -1, .9, .2, -.4, .1, .7}
	peak := studioIndependentPeak64(source)
	reversed, scaled, shifted := make([]float64, len(source)), make([]float64, len(source)), make([]float64, len(source)+7)
	for i, value := range source {
		reversed[len(source)-1-i] = value
		scaled[i] = value * .37
		shifted[i+7] = value
	}
	if got := studioIndependentPeak64(reversed); math.Abs(got-peak) > 1e-9 {
		t.Fatal("oracle changed peak under time reversal")
	}
	if got := studioIndependentPeak64(scaled); math.Abs(got-.37*peak) > 1e-9 {
		t.Fatal("oracle broke amplitude linearity")
	}
	if got := studioIndependentPeak64(shifted); math.Abs(got-peak) > 1e-9 {
		t.Fatal("oracle broke integer time-shift invariance")
	}
}
