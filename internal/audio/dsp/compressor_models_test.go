package dsp

import (
	"math"
	"testing"
)

var allTopologies = []CompTopology{CompOptical, CompVariableMu, CompFET, CompVCA}

func modelTestParams(topology CompTopology) Params {
	p := DefaultParams()
	p.Compressor = CompressorParams{Enabled: true, ThresholdDB: -24, Ratio: 4, AttackMS: 1, ReleaseMS: 120, KneeDB: 0, Topology: topology}
	return p
}

// runGR feeds mono samples and returns the reported reduction after each one.
func runGR(e *Engine, samples []float64) []float64 {
	gr := make([]float64, len(samples))
	for i, v := range samples {
		e.processCompressorSample(v, v)
		gr[i] = e.lastGRDB
	}
	return gr
}

func newModelEngine(t *testing.T, p Params) *Engine {
	t.Helper()
	if err := ValidateParams(p); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(48000)
	e.SetParams(p)
	return e
}

// A drum-like program: decaying 60 Hz hits every 250 ms over a quiet tone.
func drumProgram(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		hit := float64(i % 12000)
		out[i] = .02*math.Sin(2*math.Pi*440*float64(i)/48000) + .8*math.Exp(-hit/2400)*math.Sin(2*math.Pi*60*hit/48000)
	}
	return out
}

func TestCompressorTopologiesBehaveDifferently(t *testing.T) {
	program := drumProgram(48000)
	traces := map[CompTopology][]float64{}
	for _, topology := range allTopologies {
		traces[topology] = runGR(newModelEngine(t, modelTestParams(topology)), program)
	}
	for i, a := range allTopologies {
		for _, b := range allTopologies[i+1:] {
			diff := 0.0
			for n := range program {
				diff = math.Max(diff, math.Abs(traces[a][n]-traces[b][n]))
			}
			if diff < 1 {
				t.Errorf("%s and %s reductions differ by at most %.2f dB on the same program", a, b, diff)
			}
		}
	}
}

func TestFETCatchesTransientsAveragingTopologiesMiss(t *testing.T) {
	// A 1 ms full-scale click in silence.
	click := make([]float64, 4800)
	for i := 0; i < 48; i++ {
		click[i] = math.Sin(2 * math.Pi * 2000 * float64(i) / 48000)
	}
	peak := map[CompTopology]float64{}
	for _, topology := range allTopologies {
		for _, v := range runGR(newModelEngine(t, modelTestParams(topology)), click) {
			peak[topology] = math.Max(peak[topology], v)
		}
	}
	for _, slower := range []CompTopology{CompVariableMu, CompVCA} {
		if peak[CompFET] < peak[slower]+3 {
			t.Errorf("FET peak reduction %.2f dB should exceed %s %.2f dB by 3 dB", peak[CompFET], slower, peak[slower])
		}
	}
}

func TestOpticalRecoveryLengthensWithSustainedReduction(t *testing.T) {
	tail := func(hotSeconds float64) float64 {
		hot := int(hotSeconds * 48000)
		in := make([]float64, hot+int(.4*48000))
		for i := 0; i < hot; i++ {
			in[i] = .5 * math.Sin(2*math.Pi*1000*float64(i)/48000)
		}
		gr := runGR(newModelEngine(t, modelTestParams(CompOptical)), in)
		return gr[len(gr)-1]
	}
	brief, sustained := tail(.05), tail(3)
	if sustained < brief+1 {
		t.Fatalf("optical reduction 400 ms after release: brief %.2f dB, sustained %.2f dB; sustained work should hold longer", brief, sustained)
	}
	// Fast topologies recover fully from the same sustained work.
	p := modelTestParams(CompFET)
	in := make([]float64, 3*48000+int(.4*48000))
	for i := 0; i < 3*48000; i++ {
		in[i] = .5 * math.Sin(2*math.Pi*1000*float64(i)/48000)
	}
	if gr := runGR(newModelEngine(t, p), in); gr[len(gr)-1] > .1 {
		t.Fatalf("FET still reducing %.2f dB 400 ms after a 120 ms release", gr[len(gr)-1])
	}
}

func TestVariableMuRatioGrowsWithLevel(t *testing.T) {
	c := CompressorParams{ThresholdDB: -20, Ratio: 8, KneeDB: 6}
	if variableMuGR(-26, &c) != 0 {
		t.Fatal("variable-mu reduced below threshold minus knee")
	}
	prevRatio := 1.0
	for level := -24.0; level <= 20; level += 2 {
		gr := variableMuGR(level, &c)
		distance := level - (c.ThresholdDB - c.KneeDB)
		ratio := distance / (distance - gr)
		if gr <= 0 || ratio < prevRatio || ratio >= c.Ratio {
			t.Fatalf("level %.0f dB: reduction %.3f dB, effective ratio %.3f after %.3f", level, gr, ratio, prevRatio)
		}
		prevRatio = ratio
	}
	if prevRatio < 6 {
		t.Fatalf("variable-mu ratio only reached %.2f:1 at +20 dBFS on an 8:1 setting", prevRatio)
	}
	c.Ratio = 1
	if variableMuGR(0, &c) != 0 {
		t.Fatal("unity ratio reduced gain")
	}
}

func TestVCAAutoReleaseFollowsCrestFactor(t *testing.T) {
	release := func(in []float64) float64 {
		p := modelTestParams(CompVCA)
		p.Compressor.AutoRelease = true
		e := newModelEngine(t, p)
		var coeff float64
		for _, v := range in {
			_, coeff = e.compModel.target(v, v, &e.params.Compressor, &e.stages.compModel, e.stages.compRelease, 0)
		}
		return -1 / (math.Log(coeff) * 48000) * 2.5 * 1000
	}
	dense := make([]float64, 48000)
	sparse := make([]float64, 48000)
	for i := range dense {
		dense[i] = .5 * math.Sin(2*math.Pi*200*float64(i)/48000)
		if i%4800 < 24 {
			sparse[i] = .9
		}
	}
	denseMS, sparseMS := release(dense), release(sparse)
	if denseMS < 500 || sparseMS > 150 {
		t.Fatalf("VCA auto release: dense %.0f ms (want ≥500), sparse %.0f ms (want ≤150)", denseMS, sparseMS)
	}
}

func TestTopologySwitchGlidesWithoutJumps(t *testing.T) {
	for _, from := range allTopologies {
		for _, to := range allTopologies {
			if from == to {
				continue
			}
			e := newModelEngine(t, modelTestParams(from))
			tone := func(i int) float64 { return .5 * math.Sin(2*math.Pi*1000*float64(i)/48000) }
			for i := 0; i < 24000; i++ {
				e.processCompressorSample(tone(i), tone(i))
			}
			prev := e.lastGRDB
			e.SetParams(modelTestParams(to))
			for i := 24000; i < 26400; i++ {
				e.processCompressorSample(tone(i), tone(i))
				if math.IsNaN(e.lastGRDB) || math.Abs(e.lastGRDB-prev) > .5 {
					t.Fatalf("%s→%s: reduction jumped %.2f → %.2f dB in one sample", from, to, prev, e.lastGRDB)
				}
				prev = e.lastGRDB
			}
		}
	}
}
