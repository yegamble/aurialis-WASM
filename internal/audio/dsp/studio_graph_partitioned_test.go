package dsp

import (
	"fmt"
	"math"
	"testing"
)

func mustStudioPartitionedAudibleGraph(t testing.TB, rate float64, params Params, frames int, repeat bool) *studioGraph {
	t.Helper()
	g, err := prepareStudioPartitionedAudibleGraph(rate, params, int64(frames), repeat)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestStudioPartitionedGraphDelayIdentityAndActualWetImpulse(t *testing.T) {
	testStudioAudibleGraphDelayIdentityAndActualWetImpulse(t, mustStudioPartitionedAudibleGraph, studioPostPartitionDelay)
}

func TestStudioPartitionedGraphEpochPartitionAndRepeat(t *testing.T) {
	testStudioAudibleGraphEpochPartitionAndRepeat(t, mustStudioPartitionedAudibleGraph)
}

func TestStudioPartitionedGraphQuietPassbandAndNecessaryReduction(t *testing.T) {
	testStudioAudibleGraphQuietPassbandAndNecessaryReduction(t, mustStudioPartitionedAudibleGraph)
}

func TestStudioPartitionedGraphFixedAvailabilityAndAdmission(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioAudibleGraphActiveParams()
		g := mustStudioPartitionedAudibleGraph(t, rate, p, 128, true)
		direct := mustStudioAudibleGraph(t, rate, p, 128, true)
		if studioPostGuardAvailability != 513 || studioPartitionedPostGuardAvailability != 640 || g.latency-direct.latency != 127 || g.guard.latency != g.guard.lookahead+640+513 {
			t.Fatal("partitioned availability confused physical support or added wrong delay")
		}
		var left, right [128]float32
		for i := range left {
			left[i], right[i] = .7, -.4
		}
		if allocations := testing.AllocsPerRun(3, func() {
			if g.processBlock(left[:], right[:], left[:], right[:]) != 128 {
				panic("partitioned graph stopped")
			}
		}); allocations != 0 {
			t.Fatal("partitioned graph callback allocated")
		}
	}
	for mode := range 3 {
		p := studioAudibleGraphActiveParams()
		switch mode {
		case 0:
			p.Repair.DeClip = true
		case 1:
			p.AlgorithmVersion = 2
		case 2:
			p.LoudnessMatchAB = true
		}
		if _, err := prepareStudioPartitionedAudibleGraph(48000, p, 128, false); err == nil {
			t.Fatalf("private partitioned graph accepted unsupported contract mode%d", mode)
		}
	}
}

// Alternating controls use one compiled artifact and identical active settings.
// Finite mode measures source callbacks, not the separately tested EOF drain.
func BenchmarkStudioPartitionedGraphPairedCallbackCost(b *testing.B) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, repeat := range []bool{false, true} {
			for _, candidate := range []string{"direct-before", "partitioned", "direct-after"} {
				b.Run(fmt.Sprintf("rate%.0f/repeat%v/%s", rate, repeat, candidate), func(b *testing.B) {
					p := studioAudibleGraphActiveParams()
					p.Compressor.MakeupDB, p.DitherBits = 12, 24
					factory := mustStudioAudibleGraph
					if candidate == "partitioned" {
						factory = mustStudioPartitionedAudibleGraph
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

func TestStudioPartitionedGuardModesAndRebuiltBirths(t *testing.T) {
	testStudioPartitionedGuardModesAndRebuiltBirths(t, false)
}

func testStudioPartitionedGuardModesAndRebuiltBirths(t *testing.T, iterative bool) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		params := studioLimiterGainTestParams()
		guard, err := prepareStudioPostGuardLimiter(rate, params)
		if err != nil {
			t.Fatal(err)
		}
		path := prepareStudioPartitionedPostGuardPath(&guard)
		guard.envelope.iterative = iterative
		latency := guard.latency
		for frame := range 15000 {
			changed := true
			switch frame {
			case 2048:
				params.CeilingDBTP = -4
			case 4096:
				params.TruePeak = false
			case 6656:
				params.Enabled = false
			case 7808:
				params.Enabled = true
			case 9984:
				params.TruePeak = true
			case 12288:
				params.CeilingDBTP = -1
			default:
				changed = false
			}
			if changed {
				if frame%128 != 0 {
					t.Fatal("test control change missed explicit block boundary")
				}
				if err := path.setParams(&guard, params); err != nil {
					t.Fatal(err)
				}
			}
			delay, hold := guard.envelopeTiming()
			if (params.TruePeak && (delay != 0 || hold != 1026)) || (!params.TruePeak && (delay != 513 || hold != 0)) || guard.latency != latency {
				t.Fatal("mode change confused physical support with detector availability")
			}
			input := 2.1*math.Sin(float64(frame)*2*math.Pi*.49) + .07*math.Cos(float64(frame)*.493)
			if frame > 13000 {
				input = 0
			}
			left, right := path.process(&guard, input, input*.7)
			if guard.envelope.invalid || guard.envelope.iterative != iterative {
				t.Fatal("control rebuild changed traversal or entered invalid fallback")
			}
			clock := guard.frame - 1
			want := studioPostGuardScalarBound(&guard, clock-int64(guard.latency))
			got := guard.envelope.bound(clock)
			if math.Abs(got-want) > 2e-14 {
				t.Fatalf("rate%g frame%d partitioned planned gain%.17g want%.17g", rate, frame, got, want)
			}
			if !finite(left) || !finite(right) || math.Abs(right-.7*left) > 1e-12 {
				t.Fatal("partitioned guard lost finite linked stereo")
			}
		}
	}
}

func TestStudioPartitionedGuardDisabledExactDelayAndReset(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		params := studioLimiterGainTestParams()
		guard, err := prepareStudioPostGuardLimiter(rate, params)
		if err != nil {
			t.Fatal(err)
		}
		path := prepareStudioPartitionedPostGuardPath(&guard)
		for range 4096 {
			path.process(&guard, 2.1, -1.7)
		}
		params.Enabled = false
		if err := path.setParams(&guard, params); err != nil {
			t.Fatal(err)
		}
		guard.resetHistory()
		path.resetHistory()
		input := []float64{1, -.7, math.SmallestNonzeroFloat64, math.Copysign(0, -1)}
		for frame := 0; frame < len(input)+guard.latency; frame++ {
			value := 0.0
			if frame < len(input) {
				value = input[frame]
			}
			left, right := path.process(&guard, value, value)
			want := 0.0
			if frame >= guard.latency {
				want = input[frame-guard.latency]
			}
			if math.Float64bits(left) != math.Float64bits(want) || math.Float64bits(right) != math.Float64bits(want) {
				t.Fatalf("rate%g frame%d disabled partitioned guard changed exact delayed bytes", rate, frame)
			}
		}
		guard.resetHistory()
		path.resetHistory()
		for range guard.latency + 1 {
			left, right := path.process(&guard, 0, 0)
			if left != 0 || right != 0 {
				t.Fatal("partitioned reset retained retired audio")
			}
		}
	}
}

// Quiet enabled limiting keeps unity gain. Comparing exact delayed final bytes
// against the retained direct graph catches block-seal/EOF loss and verifies the
// same dither sequence after trimming, including records shorter than one block.
func TestStudioPartitionedGraphTinyFiniteEOFAndDither(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, count := range []int{1, 127, 128, 129} {
			for _, bits := range []int{0, 16, 24} {
				params := studioGraphNeutralParams()
				params.Limiter.Enabled, params.Limiter.TruePeak, params.DitherBits = true, true, bits
				left, right := studioGraphSignal(count)
				for i := range left {
					left[i], right[i] = left[i]*.001, right[i]*.001
				}
				left[count-1], right[count-1] = .001, -.0007
				direct := mustStudioAudibleGraph(t, rate, params, count, false)
				current := mustStudioPartitionedAudibleGraph(t, rate, params, count, false)
				a, b := renderStudioGraph(t, direct, left, right, 129)
				c, d := renderStudioGraph(t, current, left, right, 127)
				for i := range count {
					if math.Float32bits(a[direct.latency+i]) != math.Float32bits(c[current.latency+i]) || math.Float32bits(b[direct.latency+i]) != math.Float32bits(d[current.latency+i]) {
						t.Fatalf("rate%g N%d bits%d final frame%d changed quiet aligned bytes", rate, count, bits, i)
					}
				}
				if direct.gain.lastGain != 1 || direct.guard.lastGain != 1 || current.gain.lastGain != 1 || current.guard.lastGain != 1 {
					t.Fatal("quiet EOF comparison unexpectedly limited")
				}
			}
		}
	}
}
