package dsp

import (
	"fmt"
	"math"
	"testing"
)

func mustStudioAudibleGraph(t testing.TB, rate float64, params Params, frames int, repeat bool) *studioGraph {
	t.Helper()
	g, err := prepareStudioAudibleGraph(rate, params, int64(frames), repeat)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func studioAudibleGraphActiveParams() Params {
	p := studioGraphActiveParams()
	// Legacy DeClip soft clipping is not reconstruction. The new candidate
	// rejects it until an independently prepared repair stage exists.
	p.Repair.DeClip = false
	return p
}

func TestStudioAudibleGraphDelayIdentityAndActualWetImpulse(t *testing.T) {
	for rateIndex, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		want := []int{1829, 1447, 1397, 1531, 1909}[rateIndex]
		for mode := range 4 {
			p := studioGraphNeutralParams()
			if mode == 1 || mode == 2 {
				p = studioAudibleGraphActiveParams()
				p.DitherBits = 16
				p.Bypass, p.ABOriginal = mode == 1, mode == 2
			}
			if mode == 3 {
				p.Limiter.Enabled, p.Limiter.TruePeak = true, true
			}
			const count = 257
			left, right := studioGraphSignal(count)
			if mode == 3 {
				clear(left)
				clear(right)
				left[64], right[64] = 1e-4, 1e-4
			} else {
				left[1], left[2], left[3] = math.Float32frombits(1), math.Float32frombits(0x80000000), 1.5
				left[count-1], right[count-1] = .875, -.625
			}
			g := mustStudioAudibleGraph(t, rate, p, count, false)
			if g.latency != want {
				t.Fatalf("rate%g mode%d delay%d want%d", rate, mode, g.latency, want)
			}
			a, b := renderStudioGraph(t, g, left, right, 127)
			for i := 0; i < g.latency; i++ {
				if a[i] != 0 || b[i] != 0 {
					t.Fatal("candidate emitted audio before its declared buffered delay")
				}
			}
			if mode == 3 {
				peak, index := 0.0, -1
				for i, x := range a {
					if math.Abs(float64(x)) > peak {
						peak, index = math.Abs(float64(x)), i
					}
				}
				if index-64 != want || g.gain.lastGain != 1 || g.guard.lastGain != 1 {
					t.Fatalf("rate%g actual wet delay%d declared%d or unexpected limiting", rate, index-64, want)
				}
			} else {
				for i := range left {
					if math.Float32bits(a[i+want]) != math.Float32bits(left[i]) || math.Float32bits(b[i+want]) != math.Float32bits(right[i]) {
						t.Fatalf("rate%g mode%d frame%d changed exact full-band dry/original bytes", rate, mode, i)
					}
				}
			}
			t.Logf("rate%.0f mode%d measured candidate delay%d", rate, mode, want)
		}
	}
}

func TestStudioAudibleGraphEpochPartitionAndRepeat(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioAudibleGraphActiveParams()
		p.DitherBits = 24
		left, right := studioGraphSignal(513)
		one := mustStudioAudibleGraph(t, rate, p, len(left), false)
		a, b := renderStudioGraph(t, one, left, right, 513)
		many := mustStudioAudibleGraph(t, rate, p, len(left), false)
		c, d := renderStudioGraph(t, many, left, right, 127)
		for i := range a {
			if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
				t.Fatalf("rate%g frame%d partition changed final bytes", rate, i)
			}
		}
		if err := one.resetAt(137); err != nil {
			t.Fatal(err)
		}
		a, b = renderStudioGraph(t, one, left[137:], right[137:], 129)
		fresh := mustStudioAudibleGraph(t, rate, p, len(left)-137, false)
		c, d = renderStudioGraph(t, fresh, left[137:], right[137:], 127)
		for i := range a {
			if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
				t.Fatalf("rate%g frame%d seek retained retired history", rate, i)
			}
		}
		one = mustStudioAudibleGraph(t, rate, p, 129, true)
		many = mustStudioAudibleGraph(t, rate, p, 129, true)
		for block := range 40 {
			a, b, c, d = make([]float32, 129), make([]float32, 129), make([]float32, 129), make([]float32, 129)
			one.processBlock(left[:129], right[:129], a, b)
			many.processBlock(left[:127], right[:127], c[:127], d[:127])
			many.processBlock(left[127:129], right[127:129], c[127:], d[127:])
			for i := range a {
				if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
					t.Fatalf("rate%g repeat block%d frame%d changed seam", rate, block, i)
				}
			}
		}
		if err := one.beginDrain(); err == nil {
			t.Fatal("repeat accepted finite drain")
		}
	}
}

func TestStudioAudibleGraphRejectsUnsupportedContractsAndAllocatesNoCallbackMemory(t *testing.T) {
	p := studioAudibleGraphActiveParams()
	g := mustStudioAudibleGraph(t, 48000, p, 128, true)
	var left, right [128]float32
	for i := range left {
		left[i], right[i] = .7, -.4
	}
	if allocations := testing.AllocsPerRun(3, func() {
		if g.processBlock(left[:], right[:], left[:], right[:]) != 128 {
			panic("candidate stopped")
		}
	}); allocations != 0 {
		t.Fatal("candidate callback allocated")
	}
	p.Repair.DeClip = true
	if _, err := prepareStudioAudibleGraph(48000, p, 128, false); err == nil {
		t.Fatal("candidate accepted legacy soft clipping as reconstruction")
	}
	p = studioAudibleGraphActiveParams()
	p.AlgorithmVersion = 2
	if _, err := prepareStudioAudibleGraph(48000, p, 128, false); err == nil {
		t.Fatal("candidate advertised public algorithm2")
	}
	p = studioAudibleGraphActiveParams()
	p.LoudnessMatchAB = true
	if _, err := prepareStudioAudibleGraph(48000, p, 128, false); err == nil {
		t.Fatal("candidate introduced automatic level matching")
	}
}

func BenchmarkStudioAudibleGraphAllActive(b *testing.B) {
	for _, rate := range []float64{48000, 96000, 192000} {
		for _, makeup := range []float64{2, 12} {
			b.Run(fmt.Sprintf("rate%.0f/makeup%.0f", rate, makeup), func(b *testing.B) {
				p := studioAudibleGraphActiveParams()
				p.Compressor.MakeupDB, p.DitherBits = makeup, 24
				g := mustStudioAudibleGraph(b, rate, p, 128, true)
				left, right := studioGraphSignal(128)
				for i := range left {
					left[i], right[i] = 4*left[i], 4*right[i]
				}
				var a, c [128]float32
				process := func() {
					if g.processBlock(left, right, a[:], c[:]) != 128 {
						b.Fatal("candidate stopped")
					}
					studioGraphBenchmarkSink = a[127] + c[127]
				}
				for range 64 {
					process()
				}
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					process()
				}
			})
		}
	}
}

func TestStudioAudibleGraphQuietPassbandAndNecessaryReduction(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, truePeak := range []bool{false, true} {
			p := studioGraphNeutralParams()
			p.Limiter.Enabled, p.Limiter.TruePeak = true, truePeak
			const count = 8192
			left, right := make([]float32, count), make([]float32, count)
			frequency := math.Min(1000, rate*.1)
			for i := range left {
				left[i] = float32(.01 * math.Sin(2*math.Pi*frequency*float64(i)/rate))
				right[i] = left[i]
			}
			g := mustStudioAudibleGraph(t, rate, p, count, false)
			a, _ := renderStudioGraph(t, g, left, right, 129)
			margin := g.audible.kernel.pairLatency + 64
			before, after := 0.0, 0.0
			for i := margin; i < count-margin; i++ {
				before += float64(left[i]) * float64(left[i])
				after += float64(a[i+g.latency]) * float64(a[i+g.latency])
			}
			delta := 10 * math.Log10(after/before)
			if math.Abs(delta) > .1 || g.gain.lastGain != 1 || g.guard.lastGain != 1 {
				t.Fatalf("rate%g truePeak%v quiet passband changed %.9fdB or invoked reduction", rate, truePeak, delta)
			}
			if err := g.resetAt(0); err != nil {
				t.Fatal(err)
			}
			for i := range left {
				left[i] *= 180
				right[i] = left[i]
			}
			a, _ = renderStudioGraph(t, g, left, right, 127)
			peak := 0.0
			for _, value := range a[g.latency:] {
				peak = math.Max(peak, math.Abs(float64(value)))
			}
			if peak > dbToLin(p.Limiter.CeilingDBTP)+1e-6 || peak < .5 {
				t.Fatalf("rate%g truePeak%v hot sample peak%g exceeded ceiling or suppressed audio", rate, truePeak, peak)
			}
			t.Logf("rate%.0f truePeak%v quiet%.9fdB hot sample peak%.9f", rate, truePeak, delta, peak)
		}
	}
}

// Finite mode times ordinary source callbacks before EOF. The separate endpoint
// corpus measures exact drain/output bytes; a warm callback cost cannot prove it.
func BenchmarkStudioAudibleGraphCallbackCost(b *testing.B) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, repeat := range []bool{false, true} {
			b.Run(fmt.Sprintf("rate%.0f/repeat%v", rate, repeat), func(b *testing.B) {
				p := studioAudibleGraphActiveParams()
				p.Compressor.MakeupDB, p.DitherBits = 12, 24
				g := mustStudioAudibleGraph(b, rate, p, 16*1024*1024, repeat)
				left, right := studioGraphSignal(128)
				for i := range left {
					left[i], right[i] = 4*left[i], 4*right[i]
				}
				var a, c [128]float32
				process := func() {
					if g.processBlock(left, right, a[:], c[:]) != 128 {
						b.Fatal("candidate source callback stopped")
					}
					studioGraphBenchmarkSink = a[127] + c[127]
				}
				for range 64 {
					process()
				}
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					process()
				}
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/1e6, "ms/128")
				b.ReportMetric(128000/rate, "deadline_ms")
			})
		}
	}
}
