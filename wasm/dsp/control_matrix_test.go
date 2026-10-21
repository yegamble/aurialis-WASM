package main

import (
	"fmt"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

type controlCase struct {
	name          string
	before, after dsp.Params
}

// Each pair changes one field of an active module. Fixtures include stereo
// differences, low bass, high frequencies and level transitions so tests cover
// detector/ballistic controls as well as static curves.
func supportedControlCases() []controlCase {
	var cases []controlCase
	add := func(name string, base dsp.Params, change func(*dsp.Params)) {
		next := base
		change(&next)
		cases = append(cases, controlCase{name, base, next})
	}
	p := dsp.DefaultParams()
	add("input gain", p, func(p *dsp.Params) { p.InputGainDB = 3 })
	for band := range dsp.NumEQBands {
		p := dsp.DefaultParams()
		p.Bands[band].GainDB = 6
		add(fmt.Sprintf("band %d gain", band), p, func(p *dsp.Params) { p.Bands[band].GainDB = -4 })
		add(fmt.Sprintf("band %d frequency", band), p, func(p *dsp.Params) { p.Bands[band].FreqHz *= 1.8 })
		add(fmt.Sprintf("band %d Q", band), p, func(p *dsp.Params) { p.Bands[band].Q = 3 })
		add(fmt.Sprintf("band %d enabled", band), p, func(p *dsp.Params) { p.Bands[band].Enabled = false })
	}
	p.Bands[2].GainDB = 6
	add("EQ enabled", p, func(p *dsp.Params) { p.EQEnabled = false })
	add("highpass type", p, func(p *dsp.Params) { p.Bands[2].Type = dsp.FilterHighPass; p.Bands[2].GainDB = 0 })
	p = dsp.DefaultParams()
	p.Compressor.ThresholdDB = -16
	p.Compressor.Ratio = 3
	p.Compressor.AttackMS = 20
	p.Compressor.ReleaseMS = 120
	p.Compressor.KneeDB = 6
	p.Compressor.MakeupDB = 1
	add("compressor enabled", p, func(p *dsp.Params) { p.Compressor.Enabled = false })
	add("compressor threshold", p, func(p *dsp.Params) { p.Compressor.ThresholdDB = -24 })
	add("compressor ratio", p, func(p *dsp.Params) { p.Compressor.Ratio = 8 })
	add("compressor attack", p, func(p *dsp.Params) { p.Compressor.AttackMS = 80 })
	add("compressor release", p, func(p *dsp.Params) { p.Compressor.ReleaseMS = 700 })
	add("compressor knee", p, func(p *dsp.Params) { p.Compressor.KneeDB = 18 })
	add("compressor makeup", p, func(p *dsp.Params) { p.Compressor.MakeupDB = 5 })
	p = dsp.DefaultParams()
	p.Saturation.Amount = 40
	add("saturation enabled", p, func(p *dsp.Params) { p.Saturation.Enabled = false })
	add("saturation drive", p, func(p *dsp.Params) { p.Saturation.Amount = 70 })
	add("saturation Thick", p, func(p *dsp.Params) { p.Saturation.Character = dsp.SatThick })
	add("saturation Crisp", p, func(p *dsp.Params) { p.Saturation.Character = dsp.SatCrisp })
	p = dsp.DefaultParams()
	p.Stereo.WidthPct = 125
	add("stereo enabled", p, func(p *dsp.Params) { p.Stereo.Enabled = false })
	add("stereo width", p, func(p *dsp.Params) { p.Stereo.WidthPct = 60 })
	add("mono bass", p, func(p *dsp.Params) { p.Stereo.MonoBass = true })
	p = dsp.DefaultParams()
	p.InputGainDB = 9
	p.Limiter.Enabled = true
	p.Limiter.TruePeak = false
	p.Limiter.CeilingDBTP = -8
	p.Limiter.ReleaseMS = 100
	add("limiter enabled", p, func(p *dsp.Params) { p.Limiter.Enabled = false })
	add("limiter ceiling", p, func(p *dsp.Params) { p.Limiter.CeilingDBTP = -12 })
	add("limiter release", p, func(p *dsp.Params) { p.Limiter.ReleaseMS = 700 })
	return cases
}

func controlInput(rate float64) ([]float32, []float32) {
	const frames = 8192
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		time := float64(i) / rate
		envelope := 0.08
		if i%2048 < 768 {
			envelope = 0.8
		}
		left[i] = float32(envelope * (0.3*math.Sin(2*math.Pi*80*time) + 0.25*math.Sin(2*math.Pi*997*time) + 0.15*math.Sin(2*math.Pi*7000*time)))
		right[i] = float32(envelope * (0.3*math.Sin(2*math.Pi*80*time+0.9) + 0.25*math.Sin(2*math.Pi*997*time+0.3) + 0.15*math.Sin(2*math.Pi*7000*time+1.2)))
	}
	return left, right
}

func renderControl(rate float64, params dsp.Params, left, right []float32) ([]float32, []float32) {
	outputLeft, outputRight := make([]float32, len(left)), make([]float32, len(right))
	bridge := NewBridge(rate)
	bridge.SetParams(params)
	for offset := 0; offset < len(left); offset += 128 {
		bridge.ProcessBlock(left[offset:offset+128], right[offset:offset+128], outputLeft[offset:offset+128], outputRight[offset:offset+128])
	}
	return outputLeft, outputRight
}

func TestSupportedControlsChangeAudioIndependently(t *testing.T) {
	for _, control := range supportedControlCases() {
		t.Run(control.name, func(t *testing.T) {
			if err := dsp.ValidateParams(control.before); err != nil {
				t.Fatal(err)
			}
			if err := dsp.ValidateParams(control.after); err != nil {
				t.Fatal(err)
			}
			left, right := controlInput(48000)
			a, b := renderControl(48000, control.before, left, right)
			c, d := renderControl(48000, control.after, left, right)
			maximum := 0.0
			for i := range a {
				if math.IsNaN(float64(c[i])) || math.IsInf(float64(c[i]), 0) || math.IsNaN(float64(d[i])) || math.IsInf(float64(d[i]), 0) {
					t.Fatal("non-finite output")
				}
				maximum = math.Max(maximum, math.Max(math.Abs(float64(a[i]-c[i])), math.Abs(float64(b[i]-d[i]))))
			}
			if maximum < 1e-5 {
				t.Fatalf("control has no audible signal effect; maximum difference %g", maximum)
			}
		})
	}
}

func TestHighPassRejectsBassAndPreservesTreble(t *testing.T) {
	const rate = 48000.0
	left, right := make([]float32, 48000), make([]float32, 48000)
	for i := range left {
		left[i] = float32(0.1*math.Sin(2*math.Pi*100*float64(i)/rate) + 0.1*math.Sin(2*math.Pi*8000*float64(i)/rate))
		right[i] = left[i]
	}
	p := dsp.DefaultParams()
	p.Bands[0] = dsp.BandParams{Type: dsp.FilterHighPass, FreqHz: 1000, GainDB: 0, Q: 0.707, Enabled: true}
	output, _ := renderControl(rate, p, left[:47872], right[:47872])
	low := dsp.GoertzelMagnitudeDB(output, rate, 100) - dsp.GoertzelMagnitudeDB(left[:47872], rate, 100)
	high := dsp.GoertzelMagnitudeDB(output, rate, 8000) - dsp.GoertzelMagnitudeDB(left[:47872], rate, 8000)
	if low > -35 || math.Abs(high) > 0.3 {
		t.Fatalf("highpass response bass=%g treble=%g dB", low, high)
	}
}

func TestDisabledOrInactiveControlsPreserveAudio(t *testing.T) {
	left, right := controlInput(48000)
	for _, control := range supportedControlCases() {
		t.Run(control.name, func(t *testing.T) {
			before, after := control.before, control.after
			// Disable every stage; each field update must become an exact no-op.
			for _, params := range []*dsp.Params{&before, &after} {
				params.InputGainDB = 0
				params.EQEnabled = false
				params.Compressor.Enabled = false
				params.Saturation.Enabled = false
				params.Stereo.Enabled = false
				params.Limiter.Enabled = false
			}
			a, b := renderControl(48000, before, left, right)
			c, d := renderControl(48000, after, left, right)
			for i := range left {
				if a[i] != left[i] || b[i] != right[i] || c[i] != left[i] || d[i] != right[i] {
					t.Fatalf("disabled setting affected sample %d", i)
				}
			}
		})
	}
	// Zero-gain EQ frequency/Q, ratio-one compressor timing, below-threshold
	// limiting and width on a mono source must not invent a signal change.
	p := dsp.DefaultParams()
	baseline, _ := renderControl(48000, p, left, right)
	p.Bands[2].Q = 5
	p.Bands[2].FreqHz = 1500
	p.Compressor.ThresholdDB = -40
	p.Compressor.AttackMS = 90
	p.Compressor.ReleaseMS = 900
	p.Compressor.KneeDB = 18
	p.Limiter.Enabled = true
	p.Limiter.TruePeak = false
	p.Limiter.CeilingDBTP = 0
	p.Limiter.ReleaseMS = 900
	output, _ := renderControl(48000, p, left, right)
	for i := range baseline {
		if baseline[i] != output[i] {
			t.Fatalf("inactive control altered sample %d", i)
		}
	}
	p = dsp.DefaultParams()
	p.Stereo.WidthPct = 180
	monoL, monoR := renderControl(48000, p, left, left)
	for i := range left {
		if monoL[i] != left[i] || monoR[i] != left[i] {
			t.Fatalf("width altered mono at %d", i)
		}
	}
}

func TestControlResetAndBandUpdatesDoNotLeakState(t *testing.T) {
	left, right := controlInput(48000)
	bridge := NewBridge(48000)
	for _, control := range supportedControlCases() {
		bridge.SetParams(control.before)
		scratchL, scratchR := make([]float32, len(left)), make([]float32, len(right))
		bridge.ProcessBlock(left, right, scratchL, scratchR)
		bridge.SetParams(control.after)
		if bridge.Params() != control.after {
			t.Fatalf("%s mutated unrelated parameters", control.name)
		}
		bridge.Reset()
		bridge.ProcessBlock(left, right, scratchL, scratchR)
		expectedL, expectedR := renderControl(48000, control.after, left, right)
		for i := range left {
			if scratchL[i] != expectedL[i] || scratchR[i] != expectedR[i] {
				t.Fatalf("%s leaked state at frame %d", control.name, i)
			}
		}
	}
	before := bridge.Params()
	band := before.Bands[3]
	band.Type = dsp.FilterHighPass
	band.Q = 2
	bridge.SetBand(3, band)
	expected := before
	expected.Bands[3] = band
	if bridge.Params() != expected {
		t.Fatal("band type/Q update changed unrelated settings")
	}
}
