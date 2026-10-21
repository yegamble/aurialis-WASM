package dsp

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestCompressorProcessesAboveFullScaleAtZeroThreshold(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		engine := NewEngine(rate)
		p := DefaultParams()
		p.Compressor.ThresholdDB = 0
		p.Compressor.Ratio = 4
		p.Compressor.KneeDB = 0
		p.Compressor.SidechainHPFHz = 0
		p.Compressor.AttackMS = 20
		engine.SetParams(p)
		n := int(rate * 0.020)
		left := make([]float32, n)
		right := make([]float32, n)
		for i := range left {
			left[i] = 2
			right[i] = 1
		}
		engine.ProcessBlock(left, right, left, right)
		// A 2.0 DC level is +6.0206 dBFS. At 4:1 its steady reduction is
		// 4.51545 dB. Nominal attack is documented as 1-exp(-2.5) settling.
		expectedGR := 20 * math.Log10(2) * 0.75 * (1 - math.Exp(-2.5))
		expected := 2 * math.Pow(10, -expectedGR/20)
		if math.Abs(float64(left[n-1])-expected) > 2e-6 {
			t.Fatalf("rate %g: attack output %g want %g", rate, left[n-1], expected)
		}
		if left[n-1] != 2*right[n-1] {
			t.Fatal("linked compressor altered stereo ratio")
		}
	}
}

func TestIndependentGainAndPeakingResponseAcrossRates(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, gain := range []float64{-6, 6} {
			left, right := generateToneStereo(rate, 1000, 0.2, 0.2, 0)
			clear(right)
			p := DefaultParams()
			p.Compressor.Enabled = false
			p.Bands[2].GainDB = gain
			engine := NewEngine(rate)
			engine.SetParams(p)
			output := make([]float32, len(left))
			silent := make([]float32, len(left))
			engine.ProcessBlock(left, right, output, silent)
			// Coherent RMS after settling provides an independent check of center gain.
			var inputEnergy, outputEnergy float64
			for i := len(left) / 2; i < len(left); i++ {
				inputEnergy += float64(left[i]) * float64(left[i])
				outputEnergy += float64(output[i]) * float64(output[i])
			}
			delta := 10 * math.Log10(outputEnergy/inputEnergy)
			if math.Abs(delta-gain) > 0.02 {
				t.Fatalf("rate %g EQ gain %g measured %g", rate, gain, delta)
			}
			for _, x := range silent {
				if x != 0 {
					t.Fatal("EQ leaked into silent channel")
				}
			}
			p.Bands[2].GainDB = 0
			p.InputGainDB = gain
			engine.Reset()
			engine.SetParams(p)
			engine.ProcessBlock(left, right, output, silent)
			for i, x := range left {
				if math.Abs(float64(output[i])-float64(x)*math.Pow(10, gain/20)) > 1e-7 {
					t.Fatal("gain math mismatch")
				}
			}
		}
	}
}

func TestMonoBassPreservesMidAndWidthZero(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		left, right := generateToneStereo(rate, 80, 0.3, 0.2, math.Pi/2)
		p := DefaultParams()
		p.Stereo.MonoBass = true
		p.Stereo.WidthPct = 135
		outL, outR, _ := RenderBuffer(left, right, rate, p)
		for i := range left {
			before := (float64(left[i]) + float64(right[i])) / 2
			after := (float64(outL[i]) + float64(outR[i])) / 2
			if math.Abs(before-after) > 5e-8 {
				t.Fatalf("mono bass changed mid at %d: %g -> %g", i, before, after)
			}
		}
		p.Stereo.WidthPct = 0
		outL, outR, _ = RenderBuffer(left, right, rate, p)
		for i := range outL {
			if outL[i] != outR[i] {
				t.Fatal("zero width is not mono")
			}
		}
	}
}

func TestInvalidParamsCannotPoisonState(t *testing.T) {
	engine := NewEngine(48000)
	base := engine.Params()
	for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64} {
		p := base
		p.InputGainDB = bad
		if ValidateParams(p) == nil {
			t.Fatal("accepted invalid input gain")
		}
		engine.SetParams(p)
		if !reflect.DeepEqual(engine.Params(), base) {
			t.Fatal("invalid update changed parameters")
		}
		b := base.Bands[0]
		b.Q = bad
		engine.SetBand(0, b)
		if !reflect.DeepEqual(engine.Params(), base) {
			t.Fatal("invalid band update changed parameters")
		}
		if NewEngine(bad).SampleRate() != 48000 {
			t.Fatal("invalid sample rate did not use fallback")
		}
	}
	p := base
	p.InputGainDB = 36
	engine.SetParams(p)
	in := []float32{math.MaxFloat32, -math.MaxFloat32}
	out := make([]float32, 2)
	engine.ProcessBlock(in, in, out, out)
	for _, x := range out {
		if !finite(float64(x)) {
			t.Fatal("float32 narrowing overflowed")
		}
	}
}

func TestStrictParamsJSONUpdates(t *testing.T) {
	base := DefaultParams()
	for _, payload := range []string{`null`, `{} {}`, `{"inputGainDb":null}`, `{"compressor":null}`, `{"compressor":{"ratio":null}}`, `{"bands":[]}`, `{"bands":[null,null,null,null,null]}`, `{"bogus":1}`, `{"compressor":{"bogus":1}}`, `{"inputGainDb":1e300}`} {
		if _, err := DecodeParamsJSON([]byte(payload), base); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
	next, err := DecodeParamsJSON([]byte(`{"compressor":{"ratio":4}}`), base)
	if err != nil {
		t.Fatal(err)
	}
	base.Compressor.Ratio = 4
	if next != base {
		t.Fatal("partial update changed unrelated controls")
	}
}

func TestRenderContextCancellationAndFiniteInputs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := RenderBufferContext(ctx, []float32{1}, []float32{1}, 48000, DefaultParams()); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled render: %v", err)
	}
	if _, _, _, err := RenderBufferContext(context.Background(), []float32{float32(math.NaN())}, []float32{0}, 48000, DefaultParams()); err == nil {
		t.Fatal("accepted non-finite input")
	}
	if _, _, _, err := RenderBufferContext(context.Background(), []float32{0}, nil, 48000, DefaultParams()); err == nil {
		t.Fatal("accepted mismatched channel lengths")
	}
	if got := GoertzelMagnitudeDB([]float32{1}, 48000, 1000); !finite(got) {
		t.Fatal("single-sample spectrum returned NaN")
	}
}

func TestCubicPeakEstimateIsNotTruePeakCertification(t *testing.T) {
	// An fs/4 sine at pi/4 has samples +/-sqrt(.5) but a reconstruction peak
	// of 1.0. Cubic interpolation underestimates it; keep this limitation explicit.
	const n = 4096
	left := make([]float32, n)
	for i := range left {
		left[i] = float32(math.Sin(math.Pi*float64(i)/2 + math.Pi/4))
	}
	metrics := MeasureStereo(left, left, 48000)
	if metrics.TruePeakDBTP >= -0.1 {
		t.Fatal("fixture no longer demonstrates cubic underestimation; revise the limitation test")
	}
	if math.Abs(metrics.SamplePeakDBFS-(-3.0103)) > 0.001 {
		t.Fatal("fixture sample peak is incorrect")
	}
}
