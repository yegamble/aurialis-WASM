package dsp

import (
	"math"
	"slices"
	"testing"
)

func TestStudioLimiterResamplingMeasuredDelayAndPassband(t *testing.T) {
	kernel := prepareStudioLimiterAudioKernel()
	up, down := studioLimiterUpsampler{}, studioLimiterDownsampler{}
	var impulse [1024]float64
	sum, largest, maximum := 0.0, 0, 0.0
	for frame := range impulse {
		x := 0.0
		if frame == 0 {
			x = 1
		}
		impulse[frame], _ = down.process(&kernel, up.process(&kernel, x, x))
		sum += impulse[frame]
		if math.Abs(impulse[frame]) > maximum {
			largest, maximum = frame, math.Abs(impulse[frame])
		}
	}
	if largest != studioLimiterResamplingLatency || math.Abs(sum-1) > 1e-9 {
		t.Fatalf("actual4x audio impulse peak%d sum%g", largest, sum)
	}
	reversed := slices.Clone(impulse[:2*studioLimiterResamplingLatency+1])
	slices.Reverse(reversed)
	if !slices.EqualFunc(impulse[:2*studioLimiterResamplingLatency+1], reversed, func(a, b float64) bool { return math.Abs(a-b) <= 1e-12 }) {
		t.Fatal("audio up/down impulse is not symmetric around reported delay")
	}
	minimum, maximumDB := 1000.0, -1000.0
	for step := range 981 {
		frequency := float64(step) * .0005
		re, im := 0.0, 0.0
		for frame, value := range impulse {
			angle := 2 * math.Pi * frequency * float64(frame-studioLimiterResamplingLatency)
			re += value * math.Cos(angle)
			im += value * math.Sin(angle)
		}
		db := 20 * math.Log10(math.Hypot(re, im))
		minimum, maximumDB = math.Min(minimum, db), math.Max(maximumDB, db)
		if math.Abs(db) > .1 || math.Abs(im) > 1e-9 {
			t.Fatalf("actual audio passband %.4fFs: %g dB phase %g degrees", frequency, db, math.Atan2(im, re)*180/math.Pi)
		}
	}
	t.Logf("actual4x up/down integer latency%d frames,0.. .49Fs passband %g..%g dB", largest, minimum, maximumDB)
}

func TestStudioLimiterResamplingDCInvalidInputAndNoAllocations(t *testing.T) {
	kernel := prepareStudioLimiterAudioKernel()
	up, down := studioLimiterUpsampler{}, studioLimiterDownsampler{}
	var l, r float64
	for range 2048 {
		l, r = down.process(&kernel, up.process(&kernel, .2, -.1))
	}
	if math.Abs(l-.2) > 1e-12 || math.Abs(r+.1) > 1e-12 {
		t.Fatal("actual4x audio resampling changed DC gain")
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.MaxFloat32, 0} {
		l, r = down.process(&kernel, up.process(&kernel, value, -value))
		if !finite(l) || !finite(r) {
			t.Fatal("actual4x audio path emitted nonfinite output")
		}
	}
	up, down = studioLimiterUpsampler{}, studioLimiterDownsampler{}
	if got := testing.AllocsPerRun(100, func() {
		for range 128 {
			down.process(&kernel, up.process(&kernel, .2, -.1))
		}
	}); got != 0 {
		t.Fatal("actual4x audio path allocated")
	}
}

func TestStudioLimiterDownsamplerMeasuredStopband(t *testing.T) {
	kernel := prepareStudioLimiterAudioKernel()
	var response [1024]float64
	// Interleaved high-rate impulses recover the actual decimator coefficients.
	for phase := range 4 {
		down := studioLimiterDownsampler{}
		for frame := range 257 {
			var input [4][2]float64
			if frame == 0 {
				input[phase][0] = 1
			}
			sample, _ := down.process(&kernel, input)
			index := 4*frame - phase
			if index >= 0 && index < len(response) {
				response[index] = sample
			}
		}
	}
	const count = 65536
	bins := make([]complex128, count)
	for index, value := range response {
		bins[index] = complex(value, 0)
	}
	studioTestFFT(bins, false)
	stop := 0.0
	for bin, value := range bins[:count/2+1] {
		frequency := float64(bin) * 4 / count
		if frequency >= .51 {
			stop = math.Max(stop, math.Hypot(real(value), imag(value)))
		}
	}
	stopDB := 20 * math.Log10(stop)
	if stopDB > -60 {
		t.Fatalf("actual4x decimator stopband .51..2Fs %g dB", stopDB)
	}
	t.Logf("actual4x decimator .51..2Fs stopband %g dB", stopDB)
}
