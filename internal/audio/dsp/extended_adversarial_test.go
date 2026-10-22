package dsp

import (
	"math"
	"testing"
)

func TestDeHarshRangeIsAnAttenuationBound(t *testing.T) {
	p := extendedTestParams()
	base := extendedTone(p, 4500, .8, false)
	p.DeHarsh.Enabled = true
	p.DeHarsh.ThresholdDB = -60
	for _, limit := range []float64{3, 6, 12} {
		p.DeHarsh.RangeDB = limit
		cut := 20 * math.Log10(extendedTone(p, 4500, .8, false)/base)
		if cut < -limit-.2 || cut > -limit+.2 {
			t.Errorf("range %.1f dB produced %.3f dB at band center", limit, cut)
		}
	}
}

// This is a transient-safety bound, not a limiter-ceiling assertion. Legacy
// coloration and the DC blocker can overshoot unity after a polarity step.
// A nearly constant input is adversarial for ADAA: a stale antiderivative
// divided by a tiny input delta produces a large spike when the curve changes.
func TestSaturationParameterTransitionsRemainBounded(t *testing.T) {
	models := []SatCharacter{SatWarm, SatThick, SatCrisp, SatClean, SatTube, SatTape, SatTransformer}
	for _, rate := range []float64{8000, 48000} {
		for _, from := range models {
			for _, to := range models {
				p := extendedTestParams()
				p.Saturation.Character, p.Saturation.Amount = from, 5
				e := NewEngine(rate)
				e.SetParams(p)
				var left, right, outLeft, outRight [128]float32
				for block := 0; block < 100; block++ {
					for i := range left {
						left[i] = float32(.4 * math.Cos(float64(block*128+i)*.00001))
						right[i] = left[i]
					}
					e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				}
				p.Saturation.Character, p.Saturation.Amount = to, 100
				e.SetParams(p)
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				for _, value := range outLeft {
					if !finite(float64(value)) || math.Abs(float64(value)) > 2 {
						t.Fatalf("%s to %s at %.0f Hz generated unsafe sample %g", from, to, rate, value)
					}
				}
				// Disable, move the source, and re-enable the same curve.
				p.Saturation.Enabled = false
				e.SetParams(p)
				for i := range left {
					left[i], right[i] = -.25, -.25
				}
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				p.Saturation.Enabled = true
				e.SetParams(p)
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				for _, value := range outLeft {
					if !finite(float64(value)) || math.Abs(float64(value)) > 2 {
						t.Fatalf("%s reactivation at %.0f Hz generated unsafe sample %g", to, rate, value)
					}
				}
			}
		}
	}
}

// Keep the source continuous across edits: replaying the previous block can
// hide a stale ADAA integral behind a large denominator. Probe both sides of
// the divided-difference thresholds with small drive edits and inactive edits.
func TestSaturationContinuousInputEditsRemainBounded(t *testing.T) {
	models := []SatCharacter{SatWarm, SatThick, SatCrisp, SatClean, SatTube, SatTape, SatTransformer}
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, model := range models {
			for _, slope := range []float64{.000001, .000004, .00004} {
				p := extendedTestParams()
				p.Saturation.Character, p.Saturation.Amount = model, 40
				e := NewEngine(rate)
				e.SetParams(p)
				var left, right, outLeft, outRight [128]float32
				frame := 0
				render := func() {
					for i := range left {
						left[i] = float32(.2 + float64(frame)*slope)
						right[i] = -left[i]
						frame++
					}
					e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
					for i := range outLeft {
						if !finite(float64(outLeft[i])) || !finite(float64(outRight[i])) || math.Abs(float64(outLeft[i])) > 2 || math.Abs(float64(outRight[i])) > 2 {
							t.Fatalf("%s amount %g enabled %t at %.0f Hz slope %g frame %d: %g/%g", model, p.Saturation.Amount, p.Saturation.Enabled, rate, slope, frame-len(left)+i, outLeft[i], outRight[i])
						}
					}
				}
				for block := 0; block < 16; block++ {
					render()
				}
				for _, amount := range []float64{41, 40, 0, .000001, .00001, 75} {
					p.Saturation.Amount = amount
					e.SetParams(p)
					render()
				}
				p.Saturation.Enabled = false
				e.SetParams(p)
				render()
				p.Saturation.Amount = 15
				e.SetParams(p)
				render()
				p.Saturation.Enabled = true
				e.SetParams(p)
				render()
			}
		}
	}
}

func TestSaturationEditsDoNotAllocate(t *testing.T) {
	for _, model := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatClean, SatTube, SatTape, SatTransformer} {
		p := extendedTestParams()
		p.Saturation.Character, p.Saturation.Amount = model, 40
		e := NewEngine(48000)
		e.SetParams(p)
		var left, right, outLeft, outRight [128]float32
		for i := range left {
			left[i], right[i] = .2, -.2
		}
		if allocations := testing.AllocsPerRun(100, func() {
			p.Saturation.Amount = 81 - p.Saturation.Amount
			e.SetParams(p)
			e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
		}); allocations != 0 {
			t.Fatalf("%s live saturation edits allocated %g times", model, allocations)
		}
	}
}

func TestExtendedControlChangesRemainFiniteAtLowRates(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 192000} {
		p := extendedTestParams()
		p.DeHarsh.Enabled = true
		p.Multiband.Enabled = true
		p.Compressor.Ratio = 2
		e := NewEngine(rate)
		e.SetParams(p)
		var left, right, outLeft, outRight [128]float32
		for block := 0; block < 100; block++ {
			for i := range left {
				left[i] = float32(.3 * math.Sin(float64(block*128+i)*.7))
				right[i] = -left[i]
			}
			if block%2 == 0 {
				p.DeHarsh.FrequencyHz = 12000
				p.Multiband.LowMidHz, p.Multiband.MidHighHz = 1000, 12000
				p.Compressor.AutoRelease = true
			} else {
				p.DeHarsh.FrequencyHz = 1000
				p.Multiband.LowMidHz, p.Multiband.MidHighHz = 40, 1500
				p.Compressor.AutoRelease = false
			}
			e.SetParams(p)
			e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
			for _, value := range outLeft {
				if !finite(float64(value)) || math.Abs(float64(value)) > 2 {
					t.Fatalf("frequency/auto-release change at %.0f Hz generated unsafe sample %g", rate, value)
				}
			}
		}
	}
}
