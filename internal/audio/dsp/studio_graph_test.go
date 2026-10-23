package dsp

import (
	"math"
	"testing"
)

func studioGraphNeutralParams() Params {
	p := DefaultParams()
	p.EQEnabled = false
	p.Compressor.Enabled = false
	p.Saturation.Enabled = false
	p.Stereo.Enabled = false
	p.Limiter.Enabled = false
	return p
}
func studioGraphActiveParams() Params {
	p := DefaultParams()
	p.InputGainDB = 1
	p.Bands[0].GainDB = 3
	p.Bands[2].GainDB = -2
	p.Compressor.Enabled = true
	p.Compressor.KneeDB = 12
	p.Compressor.ThresholdDB = -10
	p.Compressor.Ratio = 2
	p.Compressor.MakeupDB = 2
	p.Saturation = SaturationParams{Enabled: true, Amount: 15, Character: SatTube}
	p.Stereo.Enabled = true
	p.Stereo.WidthPct = 110
	p.Stereo.MonoBass = true
	p.Stereo.CrossoverHz = 120
	p.Limiter.Enabled = true
	p.Limiter.TruePeak = true
	p.Limiter.CeilingDBTP = -1
	p.Repair = RepairParams{Enabled: true, DeEssDB: 3, TransientDB: 2, DeClip: true}
	p.DeHarsh = DeHarshParams{Enabled: true, FrequencyHz: 3000, ThresholdDB: -30, RangeDB: 3}
	p.Multiband = MultibandParams{Enabled: true, LowMidHz: 200, MidHighHz: 3000}
	for i := range p.Multiband.Bands {
		p.Multiband.Bands[i] = DynamicsBandParams{ThresholdDB: -18, Ratio: 1.5, AttackMS: 10, ReleaseMS: 100}
	}
	return p
}
func mustStudioGraph(t testing.TB, rate float64, p Params, frames int, repeat bool) *studioGraph {
	t.Helper()
	g, err := prepareStudioGraph(rate, p, int64(frames), repeat)
	if err != nil {
		t.Fatal(err)
	}
	return g
}
func renderStudioGraph(t *testing.T, g *studioGraph, left, right []float32, block int) ([]float32, []float32) {
	t.Helper()
	a, b := make([]float32, len(left)+g.latency), make([]float32, len(left)+g.latency)
	for start := 0; start < len(left); {
		count := min(block, len(left)-start)
		got := g.processBlock(left[start:start+count], right[start:start+count], a[start:start+count], b[start:start+count])
		if got != count {
			t.Fatalf("source processing returned%d want%d", got, count)
		}
		start += got
	}
	if err := g.beginDrain(); err != nil {
		t.Fatal(err)
	}
	for start := len(left); start < len(a); {
		count := min(block, len(a)-start)
		got := g.drain(a[start:start+count], b[start:start+count])
		if got != count {
			t.Fatalf("drain returned%d want%d", got, count)
		}
		start += got
	}
	if g.drain(a[:1], b[:1]) != 0 {
		t.Fatal("drain exceeded the declared fixed delay")
	}
	return a, b
}
func studioGraphSignal(count int) ([]float32, []float32) {
	left, right := make([]float32, count), make([]float32, count)
	for i := range left {
		left[i] = float32(.45*math.Sin(float64(i)*.137) + .21*math.Cos(float64(i)*.413))
		right[i] = float32(.31*math.Sin(float64(i)*.113) - .17*math.Cos(float64(i)*.337))
	}
	return left, right
}
func TestStudioGraphMeasuredLatencyExactDryOriginalAndFinalSample(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for mode := range 3 {
			p := studioGraphNeutralParams()
			if mode > 0 {
				p = studioGraphActiveParams()
				p.DitherBits = 16
				if mode == 1 {
					p.Bypass = true
				} else {
					p.ABOriginal = true
				}
			}
			const count = 257
			left, right := studioGraphSignal(count)
			left[1], left[2], left[3] = math.Float32frombits(1), math.Float32frombits(0x80000000), 1.5
			left[count-1], right[count-1] = .875, -.625
			g := mustStudioGraph(t, rate, p, count, false)
			wantDelay := 1379 + 2*int(math.Ceil(rate*.002))
			if g.latencyFrames() != wantDelay {
				t.Fatalf("rate%g delay%d want%d", rate, g.latencyFrames(), wantDelay)
			}
			a, b := renderStudioGraph(t, g, left, right, 127)
			for i := 0; i < g.latency; i++ {
				if a[i] != 0 || b[i] != 0 {
					t.Fatal("graph emitted audio before its declared delay")
				}
			}
			for i := range left {
				if math.Float32bits(a[i+g.latency]) != math.Float32bits(left[i]) || math.Float32bits(b[i+g.latency]) != math.Float32bits(right[i]) {
					t.Fatalf("rate%g mode%d frame%d changed exact delayed dry/original PCM", rate, mode, i)
				}
			}
			if g.params != p {
				t.Fatal("private graph migrated requested parameters")
			}
			t.Logf("rate%.0f mode%d measured fixed delay %d frames", rate, mode, g.latency)
		}
	}
}
func TestStudioGraphActiveBlockPartitionResetSeekAndFiniteDrain(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioGraphActiveParams()
		p.DitherBits = 24
		left, right := studioGraphSignal(4099)
		reference := mustStudioGraph(t, rate, p, len(left), false)
		a, b := renderStudioGraph(t, reference, left, right, 4096)
		for _, block := range []int{1, 127, 129} {
			g := mustStudioGraph(t, rate, p, len(left), false)
			c, d := renderStudioGraph(t, g, left, right, block)
			for i := range a {
				if !finite(float64(c[i])) || !finite(float64(d[i])) || math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
					t.Fatalf("rate%g block%d frame%d changed fixed-schedule PCM", rate, block, i)
				}
			}
		}
		if err := reference.resetAt(137); err != nil {
			t.Fatal(err)
		}
		c, d := renderStudioGraph(t, reference, left[137:], right[137:], 129)
		fresh := mustStudioGraph(t, rate, p, len(left)-137, false)
		e, f := renderStudioGraph(t, fresh, left[137:], right[137:], 127)
		for i := range c {
			if math.Float32bits(c[i]) != math.Float32bits(e[i]) || math.Float32bits(d[i]) != math.Float32bits(f[i]) {
				t.Fatal("seek epoch retained retired graph history")
			}
		}
	}
}
func TestStudioGraphRepeatIsContinuousAndCannotUseFiniteDrain(t *testing.T) {
	const frames = 257
	left, right := studioGraphSignal(frames * 20)
	for i := frames; i < len(left); i++ {
		left[i], right[i] = left[i%frames], right[i%frames]
	}
	p := studioGraphActiveParams()
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		one := mustStudioGraph(t, rate, p, frames, true)
		many := mustStudioGraph(t, rate, p, frames, true)
		a, b, c, d := make([]float32, len(left)), make([]float32, len(left)), make([]float32, len(left)), make([]float32, len(left))
		if one.processBlock(left, right, a, b) != len(left) {
			t.Fatal("repeat stopped at the first source EOF")
		}
		for start := 0; start < len(left); {
			count := min(129, len(left)-start)
			if many.processBlock(left[start:start+count], right[start:start+count], c[start:start+count], d[start:start+count]) != count {
				t.Fatal("repeat partial block failed")
			}
			start += count
		}
		for i := range a {
			if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
				t.Fatalf("rate%g repeat seam changed at frame%d", rate, i)
			}
		}
		if err := one.beginDrain(); err == nil {
			t.Fatal("repeat was silently treated as finite EOF")
		}
	}
}
func TestStudioGraphBoundedProcessingAndRejectedActiveMigrations(t *testing.T) {
	p := studioGraphActiveParams()
	g := mustStudioGraph(t, 48000, p, 4096, true)
	var a, b [128]float32
	for i := range a {
		a[i] = .5
		b[i] = -.3
	}
	if count := testing.AllocsPerRun(100, func() {
		if g.processBlock(a[:], b[:], a[:], b[:]) != len(a) {
			panic("private graph stopped")
		}
	}); count != 0 {
		t.Fatalf("private graph allocated%g", count)
	}
	p.Compressor.KneeDB = 3
	if _, err := prepareStudioGraph(48000, p, 4096, false); err == nil {
		t.Fatal("active optical knee silently migrated")
	}
	p = studioGraphActiveParams()
	p.Saturation.Character = SatWarm
	if _, err := prepareStudioGraph(48000, p, 4096, false); err == nil {
		t.Fatal("active legacy saturation silently migrated")
	}
	p = studioGraphActiveParams()
	p.AlgorithmVersion = 2
	if _, err := prepareStudioGraph(48000, p, 4096, false); err == nil {
		t.Fatal("private graph changed public algorithm2 validation")
	}
	p = studioGraphNeutralParams()
	p.LoudnessMatchAB = true
	if _, err := prepareStudioGraph(48000, p, 4096, false); err == nil {
		t.Fatal("automatic A/B level matching was silently introduced")
	}
	finiteGraph := mustStudioGraph(t, 48000, studioGraphNeutralParams(), 1, false)
	if err := finiteGraph.beginDrain(); err == nil {
		t.Fatal("premature EOF drain was accepted")
	}
}

func TestStudioGraphEnabledFiltersMeasureTheDeclaredBufferedDelay(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, saturation := range []bool{false, true} {
			p := studioGraphNeutralParams()
			p.Limiter.Enabled = true
			p.Limiter.TruePeak = true
			p.Saturation = SaturationParams{Enabled: saturation, Amount: 25, Character: SatTube}
			g := mustStudioGraph(t, rate, p, 4096, false)
			left, right := make([]float32, 4096), make([]float32, 4096)
			left[512], right[512] = 1e-4, 1e-4
			output, _ := renderStudioGraph(t, g, left, right, 129)
			peak, index := 0.0, -1
			for i, x := range output {
				if math.Abs(float64(x)) > peak {
					peak = math.Abs(float64(x))
					index = i
				}
			}
			if index-512 != g.latency {
				t.Fatalf("rate%g saturation%v actual wet impulse delay%d declared%d", rate, saturation, index-512, g.latency)
			}
			if g.gain.lastGain != 1 || g.guard.lastGain != 1 {
				t.Fatal("subthreshold impulse invoked limiting")
			}
			t.Logf("rate%.0f saturation%v measured wet impulse delay%d", rate, saturation, index-512)
		}
	}
}
