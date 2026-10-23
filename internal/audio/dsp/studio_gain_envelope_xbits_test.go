package dsp

import (
	"fmt"
	"math"
	"math/bits"
	"testing"
)

// Frozen b7297de scalar query. Do not implement this reference via boundXBits.
func frozenStudioEnvelopeBound(e *studioGainEnvelope, frame int64) float64 {
	epoch := frame / studioEnvelopeChunk
	tree := int(epoch & 1)
	x := int(frame % studioEnvelopeChunk)
	low, high, index, damage := 0, studioEnvelopeChunk-1, 1, 0.0
	for {
		n := &e.trees[tree][index]
		if n.epoch != epoch {
			break
		}
		damage = math.Max(damage, n.slope*float64(x)+n.offset)
		if low == high {
			break
		}
		mid := (low + high) / 2
		if x <= mid {
			high = mid
			index *= 2
		} else {
			low = mid + 1
			index = index*2 + 1
		}
	}
	return math.Max(0, 1-damage)
}

func checkStudioEnvelopeXBits(t *testing.T, e *studioGainEnvelope, frame int64) {
	t.Helper()
	want := math.Float64bits(frozenStudioEnvelopeBound(e, frame))
	if got := math.Float64bits(e.bound(frame)); got != want {
		t.Fatalf("legacy query changed at clock%d: bits%x want%x", frame, got, want)
	}
	if got := math.Float64bits(e.boundXBits(frame)); got != want {
		t.Fatalf("x-bit query changed at clock%d: bits%x want%x", frame, got, want)
	}
}

func TestStudioEnvelopeXBitsAllNodesAndEpochBreaks(t *testing.T) {
	if studioEnvelopeChunk != 2048 {
		t.Fatal("the private fixed-2048 proof needs fresh qualification")
	}
	for _, epoch := range []int64{0, 1, 2, (1 << 42) - 1} {
		var e studioGainEnvelope
		tree := int(epoch & 1)
		for index := 1; index < 2*studioEnvelopeChunk; index++ {
			e.trees[tree][index].epoch = epoch
		}
		// Every node is the only nonzero line in turn. Both endpoints of its
		// interval must see it; an adjacent leaf must not, except at the root.
		for index := 1; index < 2*studioEnvelopeChunk; index++ {
			depth := bits.Len(uint(index)) - 1
			width := studioEnvelopeChunk >> depth
			low := (index - (1 << depth)) * width
			e.trees[tree][index].offset = .75
			for _, x := range []int{low, low + width - 1, (low + width) % studioEnvelopeChunk} {
				frame := epoch*studioEnvelopeChunk + int64(x)
				checkStudioEnvelopeXBits(t, &e, frame)
				want := 1.0
				if x >= low && x < low+width {
					want = .25
				}
				if got := e.boundXBits(frame); got != want {
					t.Fatalf("node%d leaf%d got%g want%g", index, x, got, want)
				}
			}
			e.trees[tree][index].offset = 0
		}
		// Exercise the exact epoch break at each depth, with stronger retired
		// descendants that must never be read after the first mismatch.
		const x = 1371
		for stop := range 12 {
			index := 1
			for depth, bit := 0, studioEnvelopeChunk/2; ; depth, bit = depth+1, bit>>1 {
				e.trees[tree][index] = studioEnvelopeLine{epoch: epoch, offset: float64(depth+1) / 32}
				if depth == stop {
					e.trees[tree][index].epoch = epoch + 7
				}
				if bit == 0 {
					break
				}
				index *= 2
				if x&bit != 0 {
					index++
				}
			}
			checkStudioEnvelopeXBits(t, &e, epoch*studioEnvelopeChunk+x)
		}
	}
}

func TestStudioEnvelopeXBitsFloatBitsAndClockEdges(t *testing.T) {
	negativeZero := math.Copysign(0, -1)
	values := []float64{0, negativeZero, math.SmallestNonzeroFloat64, -math.SmallestNonzeroFloat64,
		math.Nextafter(1, 0), 1, math.Nextafter(1, 2), -.25, math.MaxFloat64, -math.MaxFloat64,
		math.Inf(1), math.Inf(-1), math.Float64frombits(0x7ff8000000001234)}
	for _, frame := range []int64{0, 1, 2047, 2048, 4095, 4096, (1 << 53) - 1, 1 << 53, math.MaxInt64, -1, -2048, math.MinInt64} {
		for i, value := range values {
			var e studioGainEnvelope
			epoch := frame / studioEnvelopeChunk
			tree := int(epoch & 1)
			for index := 1; index < 2*studioEnvelopeChunk; index++ {
				e.trees[tree][index] = studioEnvelopeLine{epoch: epoch, slope: values[(i+index)%len(values)], offset: value}
			}
			checkStudioEnvelopeXBits(t, &e, frame)
		}
	}
}

func TestStudioEnvelopeXBitsEventsWrapAndClippedRebuild(t *testing.T) {
	type event struct {
		birth    int64
		required float64
	}
	for _, cfg := range []struct{ delay, lookahead, hold int }{{0, 64, 0}, {0, 356, 0}, {0, 384, 0}, {0, 768, 0}, {0, 1536, 0}, {0, 384, 1026}, {513, 384, 0}} {
		for _, start := range []int64{0, (1 << 53) - 4096} {
			var e studioGainEnvelope
			var events [2048]event
			count, seed := 0, uint64(0x672df14a)
			for step := range 7000 {
				frame := start + int64(step)
				seed = seed*6364136223846793005 + 1442695040888963407
				if step%3 != 0 && (step < 2000 || step >= 2400) {
					required := .001 + float64(seed>>11)/float64(uint64(1)<<53)*.998
					e.add(frame, cfg.delay, cfg.lookahead, cfg.hold, required)
					events[count%len(events)] = event{frame + int64(cfg.delay), required}
					count++
				}
				if step == 1543 || step == 4099 {
					e = studioGainEnvelope{}
					for i := max(0, count-len(events)); i < count; i++ {
						v := events[i%len(events)]
						e.addActive(frame, v.birth, cfg.lookahead, cfg.hold, v.required)
					}
				}
				checkStudioEnvelopeXBits(t, &e, frame)
				if step%128 == 0 {
					before := e
					for delta := range 128 {
						checkStudioEnvelopeXBits(t, &e, frame+int64(delta))
					}
					if e != before {
						t.Fatal("query mutated finite envelope nodes")
					}
				}
			}
		}
	}
}

func TestStudioEnvelopeXBitsZeroAllocations(t *testing.T) {
	var e studioGainEnvelope
	for frame := int64(0); frame < 4096; frame++ {
		e.add(frame, 0, 1536, 0, .25)
	}
	if allocations := testing.AllocsPerRun(1000, func() {
		studioGraphBenchmarkSink = float32(e.boundXBits(4095))
	}); allocations != 0 {
		t.Fatalf("private query allocated %g", allocations)
	}
}

func BenchmarkStudioEnvelopeXBitsQuery(b *testing.B) {
	for _, kind := range []string{"empty", "sparse", "dense", "wrap"} {
		for _, path := range []string{"directBefore", "xBits", "directAfter"} {
			b.Run(fmt.Sprintf("%s/%s", kind, path), func(b *testing.B) {
				var e studioGainEnvelope
				start := int64(8192)
				if kind == "wrap" {
					start -= 127
				}
				for frame := start - 1536; frame < start+512; frame++ {
					if kind == "dense" || kind == "wrap" || (kind == "sparse" && frame%127 == 0) {
						e.add(frame, 0, 1536, 0, .02+float64(frame%97)/100)
					}
				}
				process := func() {
					for delta := range 512 {
						frame := start + int64(delta)
						if path == "xBits" {
							studioGraphBenchmarkSink = float32(e.boundXBits(frame))
						} else {
							studioGraphBenchmarkSink = float32(e.bound(frame))
						}
					}
				}
				for range 64 {
					process()
				}
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					process()
				}
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/1e6, "ms/512queries")
			})
		}
	}
}
