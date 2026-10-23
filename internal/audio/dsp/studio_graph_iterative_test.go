package dsp

import (
	"fmt"
	"math"
	"testing"
)

func mustStudioIterativePartitionedGraph(t testing.TB, rate float64, params Params, frames int, repeat bool) *studioGraph {
	t.Helper()
	g, err := prepareStudioIterativePartitionedAudibleGraph(rate, params, int64(frames), repeat)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestStudioIterativeGraphDelayIdentityAndActualWetImpulse(t *testing.T) {
	testStudioAudibleGraphDelayIdentityAndActualWetImpulse(t, mustStudioIterativePartitionedGraph, 127)
}
func TestStudioIterativeGraphEpochPartitionAndRepeat(t *testing.T) {
	testStudioAudibleGraphEpochPartitionAndRepeat(t, mustStudioIterativePartitionedGraph)
}
func TestStudioIterativeGraphQuietPassbandAndNecessaryReduction(t *testing.T) {
	testStudioAudibleGraphQuietPassbandAndNecessaryReduction(t, mustStudioIterativePartitionedGraph)
}
func TestStudioIterativeGuardModesAndRebuiltBirths(t *testing.T) {
	testStudioPartitionedGuardModesAndRebuiltBirths(t, true)
}

func studioAssertIterativeGraphState(t testing.TB, g *studioGraph) {
	t.Helper()
	if !g.gain.envelope.iterative || !g.guard.envelope.iterative || g.gain.envelope.invalid || g.guard.envelope.invalid {
		t.Fatal("private graph lost selected traversal or entered conservative failure")
	}
}

func TestStudioIterativeGraphExactFinalRecursiveParity(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, bits := range []int{16, 24} {
			params := studioAudibleGraphActiveParams()
			params.Compressor.MakeupDB, params.DitherBits = 12, bits
			left, right := studioGraphSignal(513)
			old := mustStudioPartitionedAudibleGraph(t, rate, params, len(left), false)
			current := mustStudioIterativePartitionedGraph(t, rate, params, len(left), false)
			a, b := renderStudioGraph(t, old, left, right, 129)
			c, d := renderStudioGraph(t, current, left, right, 127)
			for i := range a {
				if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
					t.Fatalf("rate%g bits%d finite frame%d changed recursive output bytes", rate, bits, i)
				}
			}
			studioAssertIterativeGraphState(t, current)
			left, right = studioGraphSignal(129)
			old = mustStudioPartitionedAudibleGraph(t, rate, params, 129, true)
			current = mustStudioIterativePartitionedGraph(t, rate, params, 129, true)
			cursor := 0
			for block := range 48 {
				if block == 16 {
					if err := old.resetAt(91); err != nil {
						t.Fatal(err)
					}
					if err := current.resetAt(91); err != nil {
						t.Fatal(err)
					}
					cursor = 91
				}
				var inputL, inputR, oldL, oldR, newL, newR [128]float32
				for i := range inputL {
					inputL[i], inputR[i] = left[cursor], right[cursor]
					cursor = (cursor + 1) % 129
				}
				if old.processBlock(inputL[:], inputR[:], oldL[:], oldR[:]) != 128 || current.processBlock(inputL[:], inputR[:], newL[:], newR[:]) != 128 {
					t.Fatal("repeat parity source stopped")
				}
				for i := range oldL {
					if math.Float32bits(oldL[i]) != math.Float32bits(newL[i]) || math.Float32bits(oldR[i]) != math.Float32bits(newR[i]) {
						t.Fatalf("rate%g bits%d block%d frame%d changed repeat bytes", rate, bits, block, i)
					}
				}
				studioAssertIterativeGraphState(t, current)
			}
		}
	}
}

func TestStudioIterativeGraphResetChoiceAndNoAllocation(t *testing.T) {
	g := mustStudioIterativePartitionedGraph(t, 48000, studioAudibleGraphActiveParams(), 513, true)
	if err := g.resetAt(137); err != nil {
		t.Fatal(err)
	}
	studioAssertIterativeGraphState(t, g)
	var left, right [128]float32
	for i := range left {
		left[i], right[i] = .7, -.4
	}
	if allocations := testing.AllocsPerRun(3, func() { g.processBlock(left[:], right[:], left[:], right[:]) }); allocations != 0 {
		t.Fatal("iterative graph callback allocated")
	}
	studioAssertIterativeGraphState(t, g)
}

func BenchmarkStudioIterativeGraphPairedCallbackCost(b *testing.B) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, repeat := range []bool{false, true} {
			for _, candidate := range []string{"recursive-before", "iterative", "recursive-after"} {
				b.Run(fmt.Sprintf("rate%.0f/repeat%v/%s", rate, repeat, candidate), func(b *testing.B) {
					p := studioAudibleGraphActiveParams()
					p.Compressor.MakeupDB, p.DitherBits = 12, 24
					factory := mustStudioPartitionedAudibleGraph
					if candidate == "iterative" {
						factory = mustStudioIterativePartitionedGraph
					}
					g := factory(b, rate, p, 16*1024*1024, repeat)
					left, right := studioGraphSignal(128)
					for i := range left {
						left[i], right[i] = 4*left[i], 4*right[i]
					}
					var outLeft, outRight [128]float32
					process := func() {
						if g.processBlock(left, right, outLeft[:], outRight[:]) != 128 {
							b.Fatal("private graph source callback stopped")
						}
						if g.gain.envelope.invalid || g.guard.envelope.invalid {
							b.Fatal("benchmark entered invalid fallback")
						}
						studioGraphBenchmarkSink = outLeft[127] + outRight[127]
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
					b.ReportMetric(float64(g.latency), "latency_frames")
				})
			}
		}
	}
}
