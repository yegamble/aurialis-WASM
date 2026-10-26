package dsp

import (
	"math"
	"testing"
)

func extendedTestParams() Params {
	p := DefaultParams()
	p.Multiband = MultibandParams{LowMidHz: 200, MidHighHz: 4000}
	for i := range p.Multiband.Bands {
		p.Multiband.Bands[i] = DynamicsBandParams{ThresholdDB: -24, Ratio: 1, AttackMS: 30, ReleaseMS: 150}
	}
	p.DeHarsh = DeHarshParams{FrequencyHz: 4500, ThresholdDB: -24, RangeDB: 6}
	return p
}

func extendedTone(p Params, freq, amp float64, side bool) float64 {
	e := NewEngine(48000)
	e.SetParams(p)
	var l, r, ol, or [128]float32
	energy := 0.0
	for block := 0; block < 300; block++ {
		for i := range l {
			l[i] = float32(amp * math.Sin(2*math.Pi*freq*float64(block*128+i)/48000))
			r[i] = l[i]
			if side {
				r[i] = -l[i]
			}
		}
		e.ProcessBlock(l[:], r[:], ol[:], or[:])
		if block >= 150 {
			for _, v := range ol {
				energy += float64(v) * float64(v)
			}
		}
	}
	return math.Sqrt(energy / (150 * 128))
}

func TestExtendedMidSideIsolation(t *testing.T) {
	p := extendedTestParams()
	baseMid := extendedTone(p, 1000, .2, false)
	baseSide := extendedTone(p, 1000, .2, true)
	p.Stereo.MidGainDB = 6
	p.Stereo.SideGainDB = -6
	mid := 20 * math.Log10(extendedTone(p, 1000, .2, false)/baseMid)
	side := 20 * math.Log10(extendedTone(p, 1000, .2, true)/baseSide)
	if math.Abs(mid-6) > .001 || math.Abs(side+6) > .001 {
		t.Fatalf("mid/side gains %g/%g", mid, side)
	}
}

func TestMultibandUnityAndIndependentCompression(t *testing.T) {
	p := extendedTestParams()
	p.Multiband.Enabled = true
	// Idle Linkwitz-Riley bands sum to an all-pass: flat magnitude, shifted phase.
	idle := extendedTestParams()
	for _, f := range []float64{40, 120, 200, 400, 1000, 2500, 4000, 8000, 16000} {
		if change := 20 * math.Log10(extendedTone(p, f, .2, false)/extendedTone(idle, f, .2, false)); math.Abs(change) > .01 {
			t.Fatalf("idle multiband changed %g Hz by %g dB", f, change)
		}
	}
	lowBase := extendedTone(p, 60, .4, false)
	highBase := extendedTone(p, 12000, .4, false)
	p.Multiband.Bands[0].Ratio = 4
	low := 20 * math.Log10(extendedTone(p, 60, .4, false)/lowBase)
	high := 20 * math.Log10(extendedTone(p, 12000, .4, false)/highBase)
	if low > -5 || math.Abs(high) > .5 {
		t.Fatalf("low-only compression changed low/high %g/%g dB", low, high)
	}
}

func TestDeHarshSelectiveAndThresholdSensitive(t *testing.T) {
	p := extendedTestParams()
	base := extendedTone(p, 4500, .4, false)
	low := extendedTone(p, 100, .4, false)
	p.DeHarsh.Enabled = true
	cut := 20 * math.Log10(extendedTone(p, 4500, .4, false)/base)
	lowChange := 20 * math.Log10(extendedTone(p, 100, .4, false)/low)
	quiet := extendedTone(p, 4500, .001, false)
	p.DeHarsh.Enabled = false
	quietBase := extendedTone(p, 4500, .001, false)
	if cut > -3 || math.Abs(lowChange) > .2 || math.Abs(quiet/quietBase-1) > .001 {
		t.Fatalf("dynamic cut=%g low=%g quiet=%g", cut, lowChange, quiet/quietBase)
	}
}

func TestNewSaturationModelsDistinctAndCleanTransparent(t *testing.T) {
	p := extendedTestParams()
	base := extendedTone(p, 1000, .5, false)
	p.Saturation.Amount = 70
	p.Saturation.Character = SatClean
	if extendedTone(p, 1000, .5, false) != base {
		t.Fatal("Clean is not transparent")
	}
	outputs := map[float64]bool{}
	for _, model := range []SatCharacter{SatTube, SatTape, SatTransformer} {
		p.Saturation.Character = model
		out := extendedTone(p, 1000, .5, false)
		if !finite(out) || math.Abs(out-base) < .00001 || outputs[out] {
			t.Fatalf("model %s is invalid or identical", model)
		}
		outputs[out] = true
	}
}

func TestExtendedStagesNoAllocations(t *testing.T) {
	p := extendedTestParams()
	p.Multiband.Enabled = true
	p.DeHarsh.Enabled = true
	p.Compressor.AutoRelease = true
	p.Compressor.Ratio = 2
	p.Saturation.Character = SatTube
	p.Saturation.Amount = 20
	e := NewEngine(48000)
	e.SetParams(p)
	var l, r, ol, or [128]float32
	if n := testing.AllocsPerRun(100, func() { e.SetParams(p); e.ProcessBlock(l[:], r[:], ol[:], or[:]) }); n != 0 {
		t.Fatalf("render/control allocated %g", n)
	}
}

func TestNewSaturationAliasBound(t *testing.T) {
	for _, rate := range []float64{44100, 48000} {
		for _, amount := range []float64{10, 50} {
			for _, model := range []SatCharacter{SatTube, SatTape, SatTransformer} {
				p := extendedTestParams()
				p.Saturation.Character = model
				p.Saturation.Amount = amount
				e := NewEngine(rate)
				e.SetParams(p)
				const count = 32768
				fundamental := rate * 7001 / count
				alias := math.Abs(rate - 3*fundamental)
				var re, im float64
				var l, r, ol, or [128]float32
				for b := 0; b < count/128+32; b++ {
					for i := range l {
						l[i] = float32(.5 * math.Sin(2*math.Pi*fundamental*float64(b*128+i)/rate))
						r[i] = l[i]
					}
					e.ProcessBlock(l[:], r[:], ol[:], or[:])
					if b >= 32 {
						for i, v := range ol {
							phase := 2 * math.Pi * alias * float64(b*128+i) / rate
							re += float64(v) * math.Cos(phase)
							im -= float64(v) * math.Sin(phase)
						}
					}
				}
				level := 20 * math.Log10(2*math.Hypot(re, im)/count+1e-15)
				t.Logf("%s %.0fHz drive%.0f folded third harmonic %.2f dBFS", model, rate, amount, level)
				if level > -45 {
					t.Fatalf("excessive measured foldback %g", level)
				}
			}
		}
	}
}

func TestExtendedSampleRateBounds(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := extendedTestParams()
		p.Multiband.Enabled = true
		p.DeHarsh.Enabled = true
		p.Multiband.MidHighHz = 12000
		p.DeHarsh.FrequencyHz = 12000
		e := NewEngine(rate)
		e.SetParams(p)
		var l, r, ol, or [128]float32
		for b := 0; b < 100; b++ {
			for i := range l {
				l[i] = float32(.4 * math.Sin(float64(i+b*128)*.2))
				r[i] = -l[i]
			}
			e.ProcessBlock(l[:], r[:], ol[:], or[:])
			for _, v := range ol {
				if !finite(float64(v)) || math.Abs(float64(v)) > 1 {
					t.Fatalf("unstable low-rate output at%g", rate)
				}
			}
		}
	}
}

func TestAutoReleaseRespondsToProgramHistory(t *testing.T) {
	// Variable-mu and FET auto release lengthen with sustained reduction.
	for _, topology := range []CompTopology{CompVariableMu, CompFET} {
		recovery := func(auto bool, hotBlocks int) float64 {
			p := extendedTestParams()
			p.Compressor.Topology = topology
			p.Compressor.AutoRelease = auto
			p.Compressor.SidechainHPFHz = 0
			p.Compressor.ThresholdDB = -30
			p.Compressor.Ratio = 4
			p.Compressor.AttackMS = 1
			p.Compressor.ReleaseMS = 100
			e := NewEngine(48000)
			e.SetParams(p)
			var l, r, ol, or [128]float32
			for b := 0; b < hotBlocks+40; b++ {
				for i := range l {
					l[i] = 0
					r[i] = 0
					if b < hotBlocks {
						l[i] = .5
						r[i] = .5
					}
				}
				e.ProcessBlock(l[:], r[:], ol[:], or[:])
			}
			return e.lastGRDB
		}
		short := recovery(true, 10)
		long := recovery(true, 400)
		manual := recovery(false, 400)
		if long < short+1 || long < manual+1 {
			t.Fatalf("%s auto short/long/manual %g/%g/%g", topology, short, long, manual)
		}
	}
}

func TestMultibandAllBandsAndCrossoverSweep(t *testing.T) {
	frequencies := []float64{80, 1000, 8000}
	for index, freq := range frequencies {
		p := extendedTestParams()
		p.Multiband.Enabled = true
		baseline := extendedTone(p, freq, .4, false)
		p.Multiband.Bands[index].Ratio = 4
		result := 20 * math.Log10(extendedTone(p, freq, .4, false)/baseline)
		if result > -2 {
			t.Fatalf("band%d did not attenuate target%gHz: %g dB", index, freq, result)
		}
	}
	p := extendedTestParams()
	p.Multiband.Enabled = true
	for _, freq := range []float64{80, 150, 200, 300, 1000, 3000, 4000, 5000, 8000} {
		baseline := extendedTone(p, freq, .2, false)
		p.Multiband.Bands[1].MakeupDB = 3
		result := 20 * math.Log10(extendedTone(p, freq, .2, false)/baseline)
		if result < -.1 || result > 3.1 {
			t.Fatalf("crossover response outside bounded broad boost%gHz: %g", freq, result)
		}
		p.Multiband.Bands[1].MakeupDB = 0
	}
}

// Audit finding 10: first-order splits leaked a low-band cut to -1 dB two
// octaves above its crossover. Linkwitz-Riley 24 dB/oct bands isolate it.
func TestMultibandCrossoversAreSteep(t *testing.T) {
	idle := extendedTestParams()
	p := extendedTestParams()
	p.Multiband.Enabled = true
	p.Multiband.LowMidHz, p.Multiband.MidHighHz = 200, 3000
	p.Multiband.Bands[0].MakeupDB = -12
	change := func(f float64) float64 {
		return 20 * math.Log10(extendedTone(p, f, .2, false)/extendedTone(idle, f, .2, false))
	}
	if got := change(50); math.Abs(got+12) > .5 {
		t.Fatalf("two octaves below the crossover: %g dB, want -12", got)
	}
	if got := change(800); math.Abs(got) > .3 {
		t.Fatalf("two octaves above the crossover: %g dB, want about 0", got)
	}
	if got := change(3000); math.Abs(got) > .05 {
		t.Fatalf("upper crossover: %g dB, want 0", got)
	}
}
