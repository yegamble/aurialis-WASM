package dsp

import (
	"context"
	"math"
	"testing"
)

func TestSamplePeakModeRetainsItsConstantSettingRender(t *testing.T) {
	left, right := make([]float32, 8192), make([]float32, 8192)
	for i := range left {
		left[i] = float32(.7*math.Sin(float64(i)*.13) + .2*math.Sin(float64(i)*.73))
		right[i] = float32(.6 * math.Cos(float64(i)*.17))
	}
	params := DefaultParams()
	params.InputGainDB = 12
	params.Limiter.Enabled, params.Limiter.TruePeak = true, false
	params.AlgorithmVersion = LegacyAlgorithmVersion
	wantL, wantR, _, err := RenderBufferContext(context.Background(), left, right, 48000, params)
	if err != nil {
		t.Fatal(err)
	}
	params.AlgorithmVersion = TruePeakAlgorithmVersion
	gotL, gotR, _, err := RenderBufferContext(context.Background(), left, right, 48000, params)
	if err != nil {
		t.Fatal(err)
	}
	for i := range left {
		if gotL[i] != wantL[i] || gotR[i] != wantR[i] {
			t.Fatalf("constant sample-peak processing changed at %d", i)
		}
	}
}

func TestLimiterReleaseToUnprotectedAudioDoesNotStep(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		limiter := newTruePeakLimiter(rate)
		ceiling := math.Pow(10, -1.0/20)
		release := math.Exp(-1 / (rate * .08))
		var previous float64
		for range int(rate / 5) {
			previous, _, _, _, _ = limiter.process(3, 3, 3, 3, ceiling, release, true)
		}
		if previous > ceiling || previous < .8 {
			t.Fatalf("%.0f: source did not exercise gain reduction: %g", rate, previous)
		}
		largest := 0.0
		for range int(rate / 20) {
			value, _, _, _, _ := limiter.process(3, 3, 3, 3, ceiling, release, false)
			largest = math.Max(largest, math.Abs(value-previous))
			previous = value
		}
		// A 5 ms raised-cosine return spreads the >2-unit gain step across
		// at least 220 frames. The previous implementation jumped by >2.
		if largest > .025 || previous != 3 {
			t.Fatalf("%.0f: release step %g, final raw sample %g", rate, largest, previous)
		}
		t.Logf("%.0f Hz: largest release step %.6f, exact final source %g", rate, largest, previous)
	}
}

func TestLimiterReleaseInterruptionPreservesProtection(t *testing.T) {
	limiter := newTruePeakLimiter(48000)
	ceiling := math.Pow(10, -1.0/20)
	for frame := range 16000 {
		limit := frame < 5000 || frame >= 5400 && frame < 9000
		value, _, _, _, _ := limiter.process(3, 3, 3, 3, ceiling, .999, limit)
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 3 {
			t.Fatalf("invalid transition sample %d: %g", frame, value)
		}
		// Judge core protection after its lookahead drains the frames that
		// were intentionally queued while limiting was off. Engine also
		// applies its immediate final ceiling when limiting is enabled.
		if limit && frame >= 5400+2*limiter.latency && value > ceiling+1e-12 {
			t.Fatalf("re-enabled limiting lost protection at %d: %g", frame, value)
		}
	}
}

func TestDisablingLimiterModesUnderReductionDoesNotStep(t *testing.T) {
	for _, mode := range []string{"limiter", "true peak"} {
		t.Run(mode, func(t *testing.T) {
			params := truePeakParams(-1)
			params.InputGainDB = 20
			engine := NewEngine(48000)
			engine.SetParams(params)
			var input, left, right [128]float32
			for i := range input {
				input[i] = .25
			}
			for range 100 {
				engine.ProcessBlock(input[:], input[:], left[:], right[:])
			}
			previous := float64(left[len(left)-1])
			if mode == "limiter" {
				params.Limiter.Enabled = false
			} else {
				params.Limiter.TruePeak = false
			}
			engine.SetParams(params)
			largest := 0.0
			for range 40 {
				engine.ProcessBlock(input[:], input[:], left[:], right[:])
				for _, sample := range left {
					largest = math.Max(largest, math.Abs(float64(sample)-previous))
					previous = float64(sample)
				}
			}
			if largest > .025 {
				t.Fatalf("audible gain step %g", largest)
			}
			want := 2.5
			if mode == "true peak" {
				want = math.Pow(10, -1.0/20)
			}
			if math.Abs(previous-want) > 1e-6 {
				t.Fatalf("did not restore the selected mode: %g, want %g", previous, want)
			}
			t.Logf("largest output step %.6f", largest)
		})
	}
}
