package dsp

import (
	"math"
	"testing"
)

func TestStudioVCATransferAndRMSDetector(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVCA)
		previous := 0.0
		for level := -60.0; level <= 0; level += 3 {
			c := mustStudioCompressor(t, rate, p)
			runStudioDC(&c, .4, math.Pow(10, level/20))
			want := studioSoftKnee(level, p)
			if math.Abs(c.reductionDB-want) > .1 || c.reductionDB < previous-1e-12 {
				t.Fatalf("rate %g level %g GR %g expected %g", rate, level, c.reductionDB, want)
			}
			previous = c.reductionDB
		}
		c := mustStudioCompressor(t, rate, p)
		optical := mustStudioCompressor(t, rate, studioTestParams(CompOptical))
		sum, count := 0.0, 0
		for frame := range int(rate * .5) {
			x := .7 * math.Sin(2*math.Pi*1000*float64(frame)/rate)
			c.process(x, -x*.5)
			optical.process(x, -x*.5)
			if frame > int(rate*.4) {
				sum += c.reductionDB
				count++
			}
		}
		want := (10*math.Log10(.7*.7/2) - p.ThresholdDB) * (1 - 1/p.Ratio)
		if math.Abs(sum/float64(count)-want) > .1 {
			t.Fatalf("rate %g power detector GR %g expected RMS %g", rate, sum/float64(count), want)
		}
		if optical.reductionDB-c.reductionDB < 1 {
			t.Fatal("RMS detector did not differ from held peak detector")
		}
	}
}

func TestStudioVCAAttackAndReleaseTau(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVCA)
		c := mustStudioCompressor(t, rate, p)
		target := 12.0
		attack, release := 0.0, 0.0
		for frame := range int(rate * .1) {
			c.process(1, .5)
			if c.reductionDB >= target*(1-math.Exp(-1)) {
				attack = float64(frame+1) / rate
				break
			}
		}
		if math.Abs(attack-p.AttackMS*.001) > p.AttackMS*.0001+.005+1/rate {
			t.Fatalf("rate %g attack %g", rate, attack)
		}
		runStudioDC(&c, .5, 1)
		for frame := range int(rate) {
			c.process(0, 0)
			if c.reductionDB <= target*math.Exp(-1) {
				release = float64(frame+1) / rate
				break
			}
		}
		if math.Abs(release-p.ReleaseMS*.001) > p.ReleaseMS*.0001+.005+1/rate {
			t.Fatalf("rate %g release %g", rate, release)
		}
	}
}

func TestStudioVCACrestMemoryAndAutoRelease(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVCA)
		p.AutoRelease = true
		dense := mustStudioCompressor(t, rate, p)
		sparse := mustStudioCompressor(t, rate, p)
		for frame := range int(rate) {
			dense.process(.25, .125)
			amplitude := 0.0
			if frame%32 == 0 {
				amplitude = 1
			}
			sparse.process(amplitude, amplitude*.5)
		}
		if dense.vca.crest > .01 || sparse.vca.crest < .65 {
			t.Fatalf("rate %g crest memory did not separate dense/sparse fixtures: %g/%g", rate, dense.vca.crest, sparse.vca.crest)
		}
		// Start both recovery probes from identical detector/GR state. Only
		// measured crest memory differs, isolating its release consequence.
		sparse.vca.power, sparse.vca.peak, sparse.vca.reduction = dense.vca.power, dense.vca.peak, dense.vca.reduction
		initial := dense.reductionDB
		runStudioDC(&dense, .05, 0)
		runStudioDC(&sparse, .05, 0)
		if initial <= 0 || dense.reductionDB-sparse.reductionDB < .2 {
			t.Fatal("crest memory did not change automatic recovery")
		}
		p.AutoRelease = false
		manual := mustStudioCompressor(t, rate, p)
		runStudioDC(&manual, 1, .25)
		runStudioDC(&manual, .05, 0)
		if math.Abs(dense.reductionDB-manual.reductionDB) < .1 {
			t.Fatal("auto release accidentally follows manual pole")
		}
	}
}

func TestStudioVCAFiniteLinkageUnityAndStateReset(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompVCA)
		c := mustStudioCompressor(t, rate, p)
		for frame := range int(rate * .1) {
			x := 1.0
			if frame%2 == 0 {
				x = -x
			}
			l, r := c.process(x, x*.25)
			if !finite(l) || r != l*.25 {
				t.Fatal("VCA altered linked channel ratio")
			}
		}
		for _, x := range []float64{math.MaxFloat32, math.NaN(), math.Inf(-1), 0} {
			l, r := c.process(x, -x)
			if !finite(l) || !finite(r) || !finite(c.reductionDB) {
				t.Fatal("VCA failed finite overload or silence")
			}
		}
		p.Ratio = 1
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .006, .25)
		if l, r := c.process(.25, -.125); l != .25 || r != -.125 || c.reductionDB != 0 {
			t.Fatal("VCA ratio1 retained reduction")
		}
		c.resetHistory()
		if c.vca != (studioVCAState{}) {
			t.Fatal("VCA reset retained state")
		}
	}
	c := mustStudioCompressor(t, 48000, studioTestParams(CompVCA))
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			c.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("VCA processing allocated")
	}
}
