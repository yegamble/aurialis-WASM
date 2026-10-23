package dsp

import (
	"math"
	"testing"
)

func studioTestParams(topology CompTopology) CompressorParams {
	p := DefaultParams().Compressor
	p.Topology, p.ThresholdDB, p.Ratio, p.KneeDB, p.SidechainHPFHz = topology, -18, 3, 6, 0
	return p
}

func mustStudioCompressor(t *testing.T, rate float64, params CompressorParams) studioCompressor {
	t.Helper()
	c, err := prepareStudioCompressor(rate, params)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func runStudioDC(c *studioCompressor, seconds, amplitude float64) {
	for range int(math.Round(seconds * c.sampleRate)) {
		c.process(amplitude, amplitude*.5)
	}
}

func TestStudioOpticalAttackTauAndTransfer(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompOptical)
		c := mustStudioCompressor(t, rate, p)
		frames := int(math.Round(rate * p.AttackMS * .001))
		for range frames {
			c.process(1, .5)
		}
		want := 12 * (1 - math.Exp(-float64(frames)/(rate*p.AttackMS*.001)))
		if math.Abs(c.reductionDB-want) > .01 {
			t.Fatalf("rate%g attack%g want%g", rate, c.reductionDB, want)
		}
		previous := -1.0
		for db := -60.0; db <= 0; db += 3 {
			c = mustStudioCompressor(t, rate, p)
			amplitude := math.Pow(10, db/20)
			runStudioDC(&c, .4, amplitude)
			over := db - p.ThresholdDB
			wantGR := 0.0
			if over >= p.KneeDB/2 {
				wantGR = over * (1 - 1/p.Ratio)
			} else if over > -p.KneeDB/2 {
				inside := over + p.KneeDB/2
				wantGR = (1 - 1/p.Ratio) * inside * inside / (2 * p.KneeDB)
			}
			if math.Abs(c.reductionDB-wantGR) > .1 || c.reductionDB < previous-1e-9 || !finite(c.reductionDB) {
				t.Fatalf("rate%g input%g GR%g want%g previous%g", rate, db, c.reductionDB, wantGR, previous)
			}
			previous = c.reductionDB
		}
	}
}

func TestStudioOpticalExposureChangesRecovery(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		var recoveries [2]float64
		for i, duration := range []float64{.05, 6} {
			c := mustStudioCompressor(t, rate, studioTestParams(CompOptical))
			runStudioDC(&c, duration, 1)
			for frame := 0; frame < int(rate*8); frame++ {
				c.process(0, 0)
				if c.reductionDB < 1 {
					recoveries[i] = float64(frame+1) / rate
					break
				}
			}
			if recoveries[i] == 0 {
				t.Fatal("optical did not recover within bounded fixture")
			}
		}
		if recoveries[1] < 2*recoveries[0] {
			t.Fatalf("rate%g optical short%g long%g", rate, recoveries[0], recoveries[1])
		}
		t.Logf("rate%g optical50ms/6s recovery to1dB: %g/%g seconds", rate, recoveries[0], recoveries[1])
	}
}

func TestStudioOpticalUnityFiniteResetAndUpdates(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompOptical)
		p.Ratio = 1
		c := mustStudioCompressor(t, rate, p)
		for i := 0; i < 1024; i++ {
			left, right := math.Sin(float64(i)*.3), math.Cos(float64(i)*.2)*.3
			l, r := c.process(left, right)
			if l != left || r != right {
				t.Fatal("ratio1 makeup0 changed input")
			}
		}
		p.Ratio = 4
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		for _, level := range []float64{0, 1, -1, math.MaxFloat32, math.NaN(), math.Inf(1)} {
			l, r := c.process(level, -level)
			if !finite(l) || !finite(r) || !finite(c.reductionDB) {
				t.Fatal("nonfinite output or detector")
			}
		}
		p.Enabled = false
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .01, .25)
		l, r := c.process(.25, -.125)
		if l != .25 || r != -.125 {
			t.Fatal("disabled model failed unity after transition")
		}
		p.Enabled = true
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		c.resetHistory()
		l, r = c.process(0, 0)
		if l != 0 || r != 0 || c.optical != (studioOpticalState{}) {
			t.Fatal("reset replayed old detector state")
		}
		before := c
		p.Ratio = 0
		if c.setParams(p) == nil || c != before {
			t.Fatal("invalid update changed model")
		}
	}
	c := mustStudioCompressor(t, 48000, studioTestParams(CompOptical))
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			c.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatalf("private model allocated %g", allocations)
	}
}

func TestStudioOpticalSidechainAndLinkedGain(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompOptical)
		plain := mustStudioCompressor(t, rate, p)
		p.SidechainHPFHz = 90
		filtered := mustStudioCompressor(t, rate, p)
		for i := 0; i < int(rate); i++ {
			x := .7 * math.Sin(2*math.Pi*40*float64(i)/rate)
			l, r := plain.process(x, x*.25)
			if math.Abs(r-l*.25) > 1e-12 {
				t.Fatal("linked detector changed stereo ratio")
			}
			filtered.process(x, x*.25)
		}
		if plain.reductionDB-filtered.reductionDB < 3 {
			t.Fatalf("rate%g SC HPF did not reduce bass drive: %g/%g", rate, plain.reductionDB, filtered.reductionDB)
		}
	}
}

func TestStudioModelPreparationDoesNotPublishAlgorithmTwo(t *testing.T) {
	p := DefaultParams()
	p.AlgorithmVersion = 2
	if ValidateParams(p) == nil {
		t.Fatal("private primitive exposed incomplete public algorithm")
	}
	for _, rate := range []float64{0, 7999, 192001, math.NaN(), math.Inf(1)} {
		if _, err := prepareStudioCompressor(rate, studioTestParams(CompOptical)); err == nil {
			t.Fatal("invalid rate accepted")
		}
	}
	pComp := studioTestParams(CompOptical)
	pComp.KneeDB = 3
	if _, err := prepareStudioCompressor(48000, pComp); err == nil {
		t.Fatal("invalid optical knee silently clamped")
	}
}

func TestStudioOpticalRatioOneAndMakeupEditLeavesNoReductionTail(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioTestParams(CompOptical)
		c := mustStudioCompressor(t, rate, p)
		runStudioDC(&c, 2, 1)
		p.Ratio = 1
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .006, .25)
		l, r := c.process(.25, -.125)
		if l != .25 || r != -.125 || c.reductionDB != 0 {
			t.Fatal("ratio1 retained gain reduction after control transition")
		}
		p.MakeupDB = 6
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		runStudioDC(&c, .006, .25)
		l, r = c.process(.25, -.125)
		want := math.Pow(10, 6.0/20)
		if math.Abs(l/.25-want) > 1e-12 || r != -.5*l {
			t.Fatal("makeup did not apply linked gain")
		}
	}
}
