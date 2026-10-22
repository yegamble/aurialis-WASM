package dsp

import (
	"math"
	"reflect"
	"testing"
)

func TestInactiveStagesDoNotReplayAudio(t *testing.T) {
	cases := []struct {
		name               string
		configure, disable func(*Params)
		band               bool
	}{
		{"eq module", func(p *Params) { p.Bands[2].GainDB = 18; p.Bands[2].Q = 20 }, func(p *Params) { p.EQEnabled = false }, false},
		{"eq band", func(p *Params) { p.Bands[2].GainDB = 18; p.Bands[2].Q = 20 }, func(p *Params) { p.Bands[2].Enabled = false }, false},
		{"eq neutral", func(p *Params) { p.Bands[2].GainDB = 18; p.Bands[2].Q = 20 }, func(p *Params) { p.Bands[2].GainDB = 0 }, false},
		{"SetBand bypass", func(p *Params) { p.Bands[2].GainDB = 18; p.Bands[2].Q = 20 }, func(p *Params) { p.Bands[2].Enabled = false }, true},
		{"SetBand neutral", func(p *Params) { p.Bands[2].GainDB = 18; p.Bands[2].Q = 20 }, func(p *Params) { p.Bands[2].GainDB = 0 }, true},
		{"saturation bypass", func(p *Params) { p.Saturation.Amount = 100 }, func(p *Params) { p.Saturation.Enabled = false }, false},
		{"saturation Clean", func(p *Params) { p.Saturation.Amount = 100 }, func(p *Params) { p.Saturation.Character = SatClean }, false},
		{"saturation zero", func(p *Params) { p.Saturation.Amount = 100 }, func(p *Params) { p.Saturation.Amount = 0 }, false},
		{"stereo bypass", func(p *Params) { p.Stereo.MonoBass = true; p.Stereo.WidthPct = 150 }, func(p *Params) { p.Stereo.Enabled = false }, false},
		{"mono bass off", func(p *Params) { p.Stereo.MonoBass = true; p.Stereo.WidthPct = 150 }, func(p *Params) { p.Stereo.MonoBass = false }, false},
		{"repair bypass", func(p *Params) { p.Repair.Enabled = true; p.Repair.DeEssDB = 24 }, func(p *Params) { p.Repair.Enabled = false }, false},
		{"deesser zero", func(p *Params) { p.Repair.Enabled = true; p.Repair.DeEssDB = 24; p.Repair.TransientDB = 6 }, func(p *Params) { p.Repair.DeEssDB = 0 }, false},
		{"de-harsh bypass", func(p *Params) { p.DeHarsh.Enabled = true; p.DeHarsh.ThresholdDB = -60; p.DeHarsh.RangeDB = 12 }, func(p *Params) { p.DeHarsh.Enabled = false }, false},
		{"multiband bypass", func(p *Params) { p.Multiband.Enabled = true; p.Multiband.Bands[0].MakeupDB = 12 }, func(p *Params) { p.Multiband.Enabled = false }, false},
		{"global bypass", func(p *Params) {
			p.Bands[2].GainDB = 18
			p.Saturation.Amount = 40
			p.Stereo.MonoBass = true
			p.DeHarsh.Enabled = true
			p.Multiband.Enabled = true
		}, func(p *Params) { p.Bypass = true }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := extendedTestParams()
			p.InputGainDB = .0001
			tc.configure(&p)
			e := NewEngine(48000)
			e.SetParams(p)
			var left, right, outLeft, outRight [128]float32
			for block := 0; block < 200; block++ {
				for i := range left {
					left[i] = float32(.4 * math.Cos(2*math.Pi*1000*float64(block*128+i)/48000))
					right[i] = -left[i]
				}
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
			}
			inactive := p
			tc.disable(&inactive)
			if tc.band {
				e.SetBand(2, inactive.Bands[2])
			} else {
				e.SetParams(inactive)
			}
			clear(left[:])
			clear(right[:])
			for block := 0; block < 400; block++ {
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
			}
			e.SetParams(p)
			for block := 0; block < 10; block++ {
				e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				for i := range outLeft {
					if outLeft[i] != 0 || outRight[i] != 0 {
						t.Fatalf("old audio after inactive silence, block %d frame %d: %g/%g", block, i, outLeft[i], outRight[i])
					}
				}
			}
		})
	}
}

func TestInactiveDynamicsReactivationStartsWithoutOldReduction(t *testing.T) {
	for _, mode := range []string{"compressor bypass", "compressor neutral", "limiter bypass", "multiband bypass"} {
		t.Run(mode, func(t *testing.T) {
			p := extendedTestParams()
			p.InputGainDB = .0001
			switch mode {
			case "compressor bypass", "compressor neutral":
				p.Compressor.SidechainHPFHz = 0
				p.Compressor.Ratio = 8
				p.Compressor.ThresholdDB = -40
				p.Compressor.AttackMS = .02
				p.Compressor.ReleaseMS = 10000
			case "limiter bypass":
				p.Limiter.Enabled = true
				p.Limiter.CeilingDBTP = -24
				p.Limiter.ReleaseMS = 10000
			case "multiband bypass":
				p.Multiband.Enabled = true
				for i := range p.Multiband.Bands {
					p.Multiband.Bands[i].Ratio = 8
					p.Multiband.Bands[i].ThresholdDB = -60
					p.Multiband.Bands[i].ReleaseMS = 2000
				}
			}
			e := NewEngine(48000)
			e.SetParams(p)
			var in, outL, outR [128]float32
			for i := range in {
				in[i] = .9
			}
			for block := 0; block < 200; block++ {
				e.ProcessBlock(in[:], in[:], outL[:], outR[:])
			}
			inactive := p
			switch mode {
			case "compressor bypass":
				inactive.Compressor.Enabled = false
			case "compressor neutral":
				inactive.Compressor.Ratio = 1
				inactive.Compressor.MakeupDB = 0
			case "limiter bypass":
				inactive.Limiter.Enabled = false
			case "multiband bypass":
				inactive.Multiband.Enabled = false
			}
			e.SetParams(inactive)
			clear(in[:])
			for block := 0; block < 400; block++ {
				e.ProcessBlock(in[:], in[:], outL[:], outR[:])
			}
			e.SetParams(p)
			fresh := NewEngine(48000)
			fresh.SetParams(p)
			var expectedL, expectedR [128]float32
			for i := range in {
				in[i] = .01
			}
			e.ProcessBlock(in[:], in[:], outL[:], outR[:])
			fresh.ProcessBlock(in[:], in[:], expectedL[:], expectedR[:])
			if outL != expectedL || outR != expectedR {
				t.Fatalf("inactive stage retained old gain reduction: first %g expected %g", outL[0], expectedL[0])
			}
		})
	}
}

func TestStageLifecyclePreservesUnrelatedHistory(t *testing.T) {
	p := extendedTestParams()
	p.Bands[2].GainDB = 6
	p.Compressor.Ratio = 4
	p.Saturation.Amount = 30
	p.Stereo.MonoBass = true
	p.Stereo.MidGainDB = 3
	p.Repair.Enabled = true
	p.Repair.DeEssDB = 6
	p.Repair.TransientDB = 6
	p.Limiter.Enabled = true
	p.DeHarsh.Enabled = true
	p.Multiband.Enabled = true
	e := NewEngine(48000)
	e.SetParams(p)
	var in, out [128]float32
	for i := range in {
		in[i] = float32(.4 * math.Cos(float64(i)))
	}
	for block := 0; block < 100; block++ {
		e.ProcessBlock(in[:], in[:], out[:], out[:])
	}
	before := *e
	// An EQ-only bypass must preserve every other stage's history bit for bit.
	next := p
	next.EQEnabled = false
	e.SetParams(next)
	expected := before
	expected.params = next
	expected.eqState = [NumEQBands][2]svfState{}
	if !reflect.DeepEqual(*e, expected) {
		t.Fatal("EQ bypass disturbed unrelated state")
	}
	// Invalid and identical updates must preserve the entire state.
	unchanged := *e
	e.SetParams(next)
	invalid := next
	invalid.Stereo.WidthPct = math.NaN()
	e.SetParams(invalid)
	if !reflect.DeepEqual(*e, unchanged) {
		t.Fatal("no-op or invalid update changed history")
	}
	// Global bypass discards signal history without restarting monitor/PRNG or M/S smoothing.
	next.Bypass = true
	e.SetParams(next)
	if e.prngState != before.prngState || e.inEnergySum != before.inEnergySum || e.outEnergySum != before.outEnergySum || e.abGainLin != before.abGainLin || e.extended.currentMid != before.extended.currentMid || e.extended.currentSide != before.extended.currentSide {
		t.Fatal("global bypass reset monitoring, dither or M/S smoothing")
	}
	// Original monitoring still evaluates the wet chain; selecting it must not reset histories.
	original := unchanged
	ab := next
	ab.Bypass = false
	ab.ABOriginal = true
	original.SetParams(ab)
	expected = unchanged
	expected.params = ab
	if !reflect.DeepEqual(original, expected) {
		t.Fatal("A/B Original cleared wet-chain state")
	}
}

func TestStageLifecycleDoesNotAllocate(t *testing.T) {
	p := extendedTestParams()
	p.Saturation.Amount = 40
	p.Compressor.Ratio = 4
	p.DeHarsh.Enabled = true
	p.Multiband.Enabled = true
	p.Stereo.MonoBass = true
	e := NewEngine(48000)
	e.SetParams(p)
	var in, left, right [128]float32
	if n := testing.AllocsPerRun(100, func() { p.Bypass = !p.Bypass; e.SetParams(p); e.ProcessBlock(in[:], in[:], left[:], right[:]) }); n != 0 {
		t.Fatalf("bypass lifecycle allocated %g times", n)
	}
}

func TestDetectorPathsClearWithoutResettingCompression(t *testing.T) {
	p := extendedTestParams()
	p.Compressor.Ratio = 4
	p.Compressor.ThresholdDB = -40
	p.Compressor.AutoRelease = true
	e := NewEngine(48000)
	e.SetParams(p)
	var in, left, right [128]float32
	for i := range in {
		in[i] = float32(.7 * math.Cos(float64(i)*.03))
	}
	for block := 0; block < 100; block++ {
		e.ProcessBlock(in[:], in[:], left[:], right[:])
	}
	before := *e
	p.Compressor.SidechainHPFHz = 0
	p.Compressor.AutoRelease = false
	e.SetParams(p)
	if e.scHPFState != ([2][2]svfState{}) || e.compSlowDB != 0 {
		t.Fatal("inactive detector subpath retained history")
	}
	if e.compPeakEnv != before.compPeakEnv || e.compEnvDB != before.compEnvDB || e.lastGRDB != before.lastGRDB {
		t.Fatal("detector subpath edit reset active compressor")
	}
}

func TestRepairPathsClearIndependently(t *testing.T) {
	for _, zeroDeEss := range []bool{true, false} {
		p := extendedTestParams()
		p.Repair.Enabled = true
		p.Repair.DeEssDB = 12
		p.Repair.TransientDB = 12
		e := NewEngine(48000)
		e.SetParams(p)
		var in, left, right [128]float32
		for i := range in {
			in[i] = float32(.7 * math.Cos(float64(i)))
		}
		for block := 0; block < 100; block++ {
			e.ProcessBlock(in[:], in[:], left[:], right[:])
		}
		before := *e
		if zeroDeEss {
			p.Repair.DeEssDB = 0
		} else {
			p.Repair.TransientDB = 0
		}
		e.SetParams(p)
		if zeroDeEss {
			if e.deEssState != ([2]svfState{}) || e.deEssEnv != 0 || e.transFast != before.transFast || e.transSlow != before.transSlow {
				t.Fatal("de-esser edit disturbed transient state or retained filter history")
			}
		} else {
			if e.transFast != 0 || e.transSlow != 0 || e.deEssState != before.deEssState || e.deEssEnv != before.deEssEnv {
				t.Fatal("transient edit disturbed de-esser state or retained envelopes")
			}
		}
	}
}

func TestSaturationModelPathsDoNotReplayAudio(t *testing.T) {
	models := []SatCharacter{SatWarm, SatThick, SatCrisp, SatClean, SatTube, SatTape, SatTransformer}
	for _, rate := range []float64{8000, 48000, 192000} {
		for _, from := range []SatCharacter{SatCrisp, SatTube, SatTape, SatTransformer} {
			for _, away := range models {
				p := extendedTestParams()
				p.Saturation.Amount = 100
				p.Saturation.Character = from
				e := NewEngine(rate)
				e.SetParams(p)
				var left, right, outLeft, outRight [128]float32
				for block := 0; block < 20; block++ {
					for i := range left {
						left[i] = float32(.4 * math.Cos(2*math.Pi*100*float64(block*128+i)/rate))
						right[i] = -left[i]
					}
					e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				}
				p.Saturation.Character = away
				e.SetParams(p)
				clear(left[:])
				clear(right[:])
				for block := 0; block < 500; block++ {
					e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
				}
				p.Saturation.Character = from
				e.SetParams(p)
				for block := 0; block < 4; block++ {
					e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
					for i := range outLeft {
						if math.Abs(float64(outLeft[i])) > 1e-7 || math.Abs(float64(outRight[i])) > 1e-7 {
							t.Fatalf("%s through %s at %.0f Hz replayed old audio: %g/%g", from, away, rate, outLeft[i], outRight[i])
						}
					}
				}
			}
		}
	}
}

func TestSaturationModelPathEditsPreserveSharedHistory(t *testing.T) {
	for _, from := range []SatCharacter{SatCrisp, SatTube, SatTape, SatTransformer} {
		for _, to := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatTube, SatTape, SatTransformer} {
			p := extendedTestParams()
			p.Saturation.Amount = 70
			p.Saturation.Character = from
			e := NewEngine(48000)
			e.SetParams(p)
			var left, right, outLeft, outRight [128]float32
			for i := range left {
				left[i] = float32(.4 * math.Cos(float64(i)*.1))
				right[i] = -left[i]
			}
			e.ProcessBlock(left[:], right[:], outLeft[:], outRight[:])
			before := *e
			p.Saturation.Character = to
			e.SetParams(p)
			if e.satPrevX != before.satPrevX || e.satPrevIn != before.satPrevIn || e.dcPrevX != before.dcPrevX || e.dcPrevY != before.dcPrevY || e.eqState != before.eqState || e.compEnvDB != before.compEnvDB {
				t.Fatalf("%s to %s reset shared running history", from, to)
			}
			if from == SatCrisp && to != SatCrisp && (e.ironLP != ([2]float64{}) || e.ironHP != ([2]float64{})) {
				t.Fatal("stopped Crisp filter retained history")
			}
			if from != SatCrisp && (to == SatWarm || to == SatThick || to == SatCrisp) && e.extended.colorLP != ([2]float64{}) {
				t.Fatal("stopped coloration filter retained history")
			}
			if from != SatCrisp && (to == SatTube || to == SatTape || to == SatTransformer) && e.extended.colorLP != before.extended.colorLP {
				t.Fatal("running coloration filter lost history")
			}
		}
	}
}

func TestSaturationModelPathEditsDoNotAllocate(t *testing.T) {
	models := []SatCharacter{SatCrisp, SatThick, SatTube, SatTape, SatTransformer, SatWarm}
	p := extendedTestParams()
	p.Saturation.Amount = 70
	e := NewEngine(48000)
	e.SetParams(p)
	var in, left, right [128]float32
	index := 0
	if n := testing.AllocsPerRun(100, func() {
		p.Saturation.Character = models[index%len(models)]
		index++
		e.SetParams(p)
		e.ProcessBlock(in[:], in[:], left[:], right[:])
	}); n != 0 {
		t.Fatalf("saturation model path edits allocated %g times", n)
	}
}
