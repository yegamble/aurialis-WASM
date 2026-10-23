package dsp

import (
	"math"
	"testing"
)

func TestStudioFETTransferAndContinuousTightKnee(t *testing.T) {
	for _, knee := range []float64{0, 1, 3, 6} {
		p := studioTestParams(CompFET)
		p.KneeDB = knee
		previousGR, previousOutput := 0.0, -100.0
		for level := -60.0; level <= 0; level += .01 {
			gr := studioSoftKnee(level, p)
			if !finite(gr) || gr < previousGR-1e-10 || level-gr < previousOutput-1e-10 || math.Abs(studioSoftKnee(level+1e-7, p)-gr) > 1e-6 {
				t.Fatal("FET curve is not continuous with monotone reduction/output")
			}
			previousGR, previousOutput = gr, level-gr
		}
	}
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompFET)
		for level := -60.0; level <= 0; level += 3 {
			c := mustStudioCompressor(t, rate, p)
			runStudioDC(&c, .4, math.Pow(10, level/20))
			if math.Abs(c.reductionDB-studioSoftKnee(level, p)) > .1 {
				t.Fatalf("rate %g level %g FET transfer %g", rate, level, c.reductionDB)
			}
		}
	}
	p := studioTestParams(CompFET)
	p.KneeDB = 7
	if _, err := prepareStudioCompressor(48000, p); err == nil {
		t.Fatal("FET silently clamped an unsupported knee")
	}
}

func TestStudioFETAttackTauIncludesShortestControl(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, attack := range []float64{.02, .1, 18, 500} {
			p := studioTestParams(CompFET)
			p.AttackMS = attack
			c := mustStudioCompressor(t, rate, p)
			tau := .25 * attack * .001
			frames := max(1, int(math.Ceil(tau*rate)))
			crossing := 0
			for frame := range frames {
				c.process(1, .5)
				if crossing == 0 && c.reductionDB >= 12*(1-math.Exp(-1))-1e-9 {
					crossing = frame + 1
				}
			}
			want := 12 * (1 - math.Exp(-float64(frames)/(rate*tau)))
			if !finite(c.reductionDB) || math.Abs(c.reductionDB-want) > 1e-8 || crossing == 0 || math.Abs(float64(crossing)/rate-tau) > .1*tau+1/rate {
				t.Fatalf("rate %g attack %g: GR %g expected %g, crossing %d", rate, attack, c.reductionDB, want, crossing)
			}
		}
	}
}

func TestStudioFETReleaseTauAndAutomaticMemory(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompFET)
		for _, release := range []float64{5, 140} {
			p.ReleaseMS = release
			c := mustStudioCompressor(t, rate, p)
			runStudioDC(&c, .2, 1)
			elapsed := 0.0
			for frame := range int(rate * .5) {
				c.process(0, 0)
				if c.reductionDB <= 12*math.Exp(-1) {
					elapsed = float64(frame+1) / rate
					break
				}
			}
			if elapsed == 0 || math.Abs(elapsed-release*.001) > release*.0001+.0005+1/rate {
				t.Fatalf("rate %g release %g elapsed %g", rate, release, elapsed)
			}
		}
		p.ReleaseMS, p.AutoRelease = 140, true
		short := mustStudioCompressor(t, rate, p)
		long := mustStudioCompressor(t, rate, p)
		runStudioDC(&short, .01, 1)
		runStudioDC(&long, 2, 1)
		shortGR, longGR := short.reductionDB, long.reductionDB
		runStudioDC(&short, .15, 0)
		runStudioDC(&long, .15, 0)
		if long.reductionDB/longGR < 2*short.reductionDB/shortGR || long.reductionDB-short.reductionDB < .5 {
			t.Fatalf("rate %g FET auto normalized short/long %g/%g", rate, short.reductionDB/shortGR, long.reductionDB/longGR)
		}
		p.AutoRelease = false
		manual := mustStudioCompressor(t, rate, p)
		runStudioDC(&manual, 2, 1)
		runStudioDC(&manual, .15, 0)
		if math.Abs(long.reductionDB-manual.reductionDB) < .2 {
			t.Fatal("FET automatic recovery accidentally follows manual pole")
		}
	}
}

func TestStudioFETIsFasterThanOpticalAndResetsState(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompFET)
		c := mustStudioCompressor(t, rate, p)
		optical := mustStudioCompressor(t, rate, studioTestParams(CompOptical))
		runStudioDC(&c, .001, 1)
		runStudioDC(&optical, .001, 1)
		if c.reductionDB-optical.reductionDB < 1 {
			t.Fatal("FET failed to distinguish its fast attack")
		}
		c.resetHistory()
		if c.fet != (studioFETState{}) {
			t.Fatal("FET reset retained state")
		}
		for _, x := range []float64{0, 1, -1, math.MaxFloat32, math.NaN(), math.Inf(1)} {
			l, r := c.process(x, x*.5)
			if !finite(l) || !finite(r) || r != l*.5 || !finite(c.reductionDB) {
				t.Fatal("FET failed finite linked output")
			}
		}
		p.Ratio = 1
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .006, .25)
		if l, r := c.process(.25, -.125); l != .25 || r != -.125 || c.reductionDB != 0 {
			t.Fatal("FET ratio1 retained reduction")
		}
	}
	c := mustStudioCompressor(t, 48000, studioTestParams(CompFET))
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			c.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("FET processing allocated")
	}
}
