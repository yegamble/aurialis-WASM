package dsp

import (
	"math"
	"testing"
)

func studioLimiterGainTestParams() LimiterParams {
	p := DefaultParams().Limiter
	p.Enabled, p.TruePeak, p.CeilingDBTP = true, true, -1
	return p
}

func TestStudioLimiterGain4xActualSamplesBoundLinkedAndTail(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		l, err := prepareStudioLimiterGain4x(rate, studioLimiterGainTestParams())
		if err != nil {
			t.Fatal(err)
		}
		if l.lookahead != 4*int(math.Ceil(rate*.002)) {
			t.Fatal("4x gain lookahead clock mismatch")
		}
		const count = 8192
		source := make([]float64, count)
		for i := range source {
			source[i] = 1.8*math.Sin(float64(i)*.371) + .7*math.Cos(float64(i)*.153)
		}
		source[count-1] = 2
		last := 0.0
		for frame := 0; frame < count+l.lookahead; frame++ {
			x := 0.0
			if frame < len(source) {
				x = source[frame]
			}
			left, right, dryLeft, dryRight := l.process(x, x*.7)
			if math.Abs(left) > l.ceiling+1e-12 || math.Abs(right) > l.ceiling+1e-12 || l.lastGain < 0 || l.lastGain > 1 {
				t.Fatalf("rate%g4x gain failed its high-rate sample bound", rate)
			}
			if math.Abs(right-.7*left) > 1e-12 || dryRight != dryLeft*.7 {
				t.Fatal("4x gain unlinked stereo")
			}
			if frame >= l.lookahead && dryLeft != source[frame-l.lookahead] {
				t.Fatal("4x delay changed source samples")
			}
			last = left
		}
		if math.Abs(last) < .01 {
			t.Fatal("4x gain dropped the final source sample")
		}
		l.resetHistory()
		for range l.lookahead + 8 {
			a, b, _, _ := l.process(0, 0)
			if a != 0 || b != 0 {
				t.Fatal("4x reset replayed old audio")
			}
		}
	}
}

func TestStudioLimiterGain4xTransparentDisabledInvalidAndNoAllocations(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, enabled := range []bool{true, false} {
			p := studioLimiterGainTestParams()
			p.Enabled = enabled
			l, err := prepareStudioLimiterGain4x(rate, p)
			if err != nil {
				t.Fatal(err)
			}
			const count = 2048
			source := make([]float64, count)
			for i := range source {
				source[i] = .05 * math.Sin(float64(i)*.317)
			}
			source[17] = 1e-35
			source[19] = math.Copysign(0, -1)
			if !enabled {
				source[123] = 2
			}
			for frame := 0; frame < count+l.lookahead; frame++ {
				x := 0.0
				if frame < len(source) {
					x = source[frame]
				}
				a, b, _, _ := l.process(x, x)
				if frame >= l.lookahead && (math.Float64bits(a) != math.Float64bits(source[frame-l.lookahead]) || math.Float64bits(b) != math.Float64bits(a)) {
					t.Fatal("unreduced4x gain failed exact delayed null")
				}
			}
			if l.lastGain != 1 {
				t.Fatal("transparent4x gain was needlessly reduced")
			}
		}
	}
	if _, err := prepareStudioLimiterGain4x(math.NaN(), studioLimiterGainTestParams()); err == nil {
		t.Fatal("4x preparation accepted invalid rate")
	}
	l, err := prepareStudioLimiterGain4x(48000, studioLimiterGainTestParams())
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []float64{math.MaxFloat32, math.NaN(), math.Inf(1), 0} {
		a, b, _, _ := l.process(value, -value)
		if !finite(a) || !finite(b) {
			t.Fatal("4x gain emitted nonfinite output")
		}
	}
	if got := testing.AllocsPerRun(100, func() {
		for range 128 {
			l.process(1.8, -1.2)
		}
	}); got != 0 {
		t.Fatal("4x gain processing allocated")
	}
}
