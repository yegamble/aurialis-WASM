package dsp

import (
	"math"
	"testing"
)

func TestStudioMuProgressiveCurveContinuityAndSteadyTransfer(t *testing.T) {
	for _, knee := range []float64{0, 6, 12} {
		p := studioTestParams(CompVariableMu)
		p.KneeDB = knee
		previous := 0.0
		for level := -60.0; level <= 12; level += .1 {
			gr := studioMuReduction(level, p)
			if !finite(gr) || gr < previous-1e-10 || gr < 0 {
				t.Fatal("progressive curve not finite and monotone")
			}
			if knee > 0 && math.Abs(studioMuReduction(level+1e-7, p)-gr) > 1e-6 {
				t.Fatal("progressive curve has a discontinuity")
			}
			previous = gr
		}
	}
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVariableMu)
		for _, level := range []float64{-60, -30, -24, -20, -18, -12, -6, 0} {
			c := mustStudioCompressor(t, rate, p)
			runStudioDC(&c, .4, math.Pow(10, level/20))
			x := math.Max(0, level-(p.ThresholdDB-p.KneeDB))
			want := 0.0
			if x > 0 {
				ratio := 1 + (p.Ratio-1)*x/(x+p.KneeDB)
				want = x * (1 - 1/ratio)
			}
			if math.Abs(c.reductionDB-want) > .1 {
				t.Fatalf("rate%g level%g GR%g want%g", rate, level, c.reductionDB, want)
			}
		}
	}
}

func TestStudioMuAttackAndReleaseTauWithDetectorWindow(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVariableMu)
		c := mustStudioCompressor(t, rate, p)
		target := studioMuReduction(0, p)
		attack := 0.0
		for frame := 0; frame < int(rate*.1); frame++ {
			c.process(1, .5)
			if c.reductionDB >= target*(1-math.Exp(-1)) {
				attack = float64(frame+1) / rate
				break
			}
		}
		if math.Abs(attack-p.AttackMS*.001) > .1*p.AttackMS*.001+.002+1/rate {
			t.Fatalf("rate%g attack%g", rate, attack)
		}
		runStudioDC(&c, .5, 1)
		release := 0.0
		for frame := 0; frame < int(rate); frame++ {
			c.process(0, 0)
			if c.reductionDB <= target*math.Exp(-1) {
				release = float64(frame+1) / rate
				break
			}
		}
		if math.Abs(release-p.ReleaseMS*.001) > .1*p.ReleaseMS*.001+.002+1/rate {
			t.Fatalf("rate%g release%g", rate, release)
		}
	}
}

func TestStudioMuUnityLinkageAndModelSwitchDoesNotReplayState(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVariableMu)
		c := mustStudioCompressor(t, rate, p)
		runStudioDC(&c, .4, 1)
		if math.Abs(c.reductionDB-12) < 1 {
			t.Fatal("progressive curve accidentally matches optical transfer")
		}
		for _, level := range []float64{1, -1, 0, math.MaxFloat32, math.NaN(), math.Inf(1)} {
			l, r := c.process(level, level*.5)
			if !finite(l) || !finite(r) || !finite(c.reductionDB) || math.Abs(r-l*.5) > 1e-9 {
				t.Fatal("invalid linked finite output")
			}
		}
		p.Ratio = 1
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .006, .25)
		if l, r := c.process(.25, -.125); l != .25 || r != -.125 {
			t.Fatal("ratio1 not unity")
		}
		p = studioTestParams(CompOptical)
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range int(rate * .01) {
			if l, r := c.process(0, 0); l != 0 || r != 0 {
				t.Fatal("switch replayed old audio")
			}
		}
		if c.variableMu != (studioMuState{}) || c.optical != (studioOpticalState{}) {
			t.Fatal("switch retained stopped-model memory")
		}
		p = studioTestParams(CompVariableMu)
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .1, 1)
		c.resetHistory()
		if c.variableMu != (studioMuState{}) {
			t.Fatal("reset retained progressive state")
		}
	}
	c := mustStudioCompressor(t, 48000, studioTestParams(CompVariableMu))
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			c.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("progressive processing allocated")
	}
}

func TestStudioMuAutoReleaseRespondsToExposure(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVariableMu)
		p.AutoRelease = true
		short := mustStudioCompressor(t, rate, p)
		long := mustStudioCompressor(t, rate, p)
		runStudioDC(&short, .05, 1)
		runStudioDC(&long, 2, 1)
		shortGR, longGR := short.reductionDB, long.reductionDB
		runStudioDC(&short, .15, 0)
		runStudioDC(&long, .15, 0)
		if long.reductionDB/longGR < short.reductionDB/shortGR+.1 {
			t.Fatal("auto release did not retain greater sustained-program memory")
		}
		p.AutoRelease = false
		manual := mustStudioCompressor(t, rate, p)
		runStudioDC(&manual, 2, 1)
		runStudioDC(&manual, .15, 0)
		if long.reductionDB < manual.reductionDB+1 {
			t.Fatal("auto release accidentally follows the manual pole")
		}
	}
}
