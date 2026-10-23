package dsp

import (
	"math"
	"testing"
)

func studioAssertRecursiveEnvelopeBits(t *testing.T, got *studioGainEnvelope, want *studioRecursiveGainEnvelope) {
	t.Helper()
	if got.invalid {
		t.Fatal("admitted iterative envelope entered conservative invalid fallback")
	}
	for tree := range got.trees {
		for node, value := range got.trees[tree] {
			old := want.trees[tree][node]
			if value.epoch != old.epoch || math.Float64bits(value.slope) != math.Float64bits(old.slope) || math.Float64bits(value.offset) != math.Float64bits(old.offset) {
				t.Fatalf("tree%d node%d changed exact epoch/line state", tree, node)
			}
		}
	}
}

func TestStudioIterativeEnvelopeBitwiseEventsChunksEpochsAndRebuild(t *testing.T) {
	for _, start := range []int64{0, 9007199254740000} {
		for _, config := range []struct{ delay, lookahead, hold int }{{0, 64, 0}, {0, 1536, 0}, {0, 384, 1026}, {513, 384, 0}} {
			got := studioGainEnvelope{iterative: true}
			var want studioRecursiveGainEnvelope
			type event struct {
				frame    int64
				required float64
			}
			var events [studioEnvelopeChunk]event
			seed := uint64(0x519c73)
			for position := range 7000 {
				frame := start + int64(position)
				if position == 3072 || position == 5120 {
					got.resetHistory()
					want = studioRecursiveGainEnvelope{}
					for _, old := range events {
						if old.required <= 0 || old.frame > frame {
							continue
						}
						required := math.Min(1, old.required*.83)
						birth := old.frame + int64(config.delay)
						got.addActive(frame, birth, config.lookahead, config.hold, required)
						want.addActive(frame, birth, config.lookahead, config.hold, required)
					}
				}
				seed = seed*6364136223846793005 + 1442695040888963407
				required := .001 + float64(seed>>11)/float64(uint64(1)<<53)*.998
				if position%7 == 0 || position > 6200 {
					required = 1
				}
				if position%19 == 0 {
					required = .5
				}
				got.add(frame, config.delay, config.lookahead, config.hold, required)
				want.add(frame, config.delay, config.lookahead, config.hold, required)
				events[position&(studioEnvelopeChunk-1)] = event{frame, required}
				if math.Float64bits(got.bound(frame)) != math.Float64bits(want.bound(frame)) || got.invalid {
					t.Fatalf("start%d config%v frame%d changed per-frame bound or entered fallback", start, config, frame)
				}
				if position%128 == 0 {
					studioAssertRecursiveEnvelopeBits(t, &got, &want)
				}
			}
			studioAssertRecursiveEnvelopeBits(t, &got, &want)
		}
	}
}

func TestStudioIterativeEnvelopeActualGainBitwiseAndReset(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		got, err := prepareStudioLimiterGain4x(rate, studioLimiterGainTestParams())
		if err != nil {
			t.Fatal(err)
		}
		want := got
		got.envelope.iterative = true
		for frame := range 22000 {
			switch frame {
			case 6400:
				got.enabled, want.enabled = false, false
			case 8192:
				got.enabled, want.enabled = true, true
			case 10240:
				got.ceiling, want.ceiling = got.ceiling*.8, want.ceiling*.8
			case 15000:
				got.resetHistory()
				want.resetHistory()
				if !got.envelope.iterative || want.envelope.iterative {
					t.Fatal("reset changed prepared traversal choice")
				}
			}
			value := 2.1*math.Sin(.217*float64(frame)) + .07*math.Cos(.493*float64(frame))
			if frame > 12000 && frame < 14000 {
				value = 0
			}
			if frame == 18001 {
				value = 20
			}
			a, b, c, d := got.process(value, .7*value)
			w, x, y, z := want.process(value, .7*value)
			for _, pair := range [][2]float64{{a, w}, {b, x}, {c, y}, {d, z}, {got.lastGain, want.lastGain}, {got.fastGain, want.fastGain}, {got.slowGain, want.slowGain}, {got.exposure, want.exposure}} {
				if math.Float64bits(pair[0]) != math.Float64bits(pair[1]) {
					t.Fatalf("rate%g frame%d changed actual gain/audio bits", rate, frame)
				}
			}
			if got.envelope.invalid {
				t.Fatal("actual gain entered fallback")
			}
		}
	}
}

func TestStudioIterativeEnvelopeScratchAdmissionAndNoAllocation(t *testing.T) {
	if studioEnvelopeChunk != 1<<studioEnvelopeTreeDepth || studioEnvelopeScratchEntries != 12 {
		t.Fatal("tree depth/scratch contract changed")
	}
	// Traverse the ENTIRE binary tree, which retains at least as many pending
	// siblings as any pruned range query. This independently witnesses the bound.
	var stack [studioEnvelopeScratchEntries]studioEnvelopeRangeNode
	stack[0] = studioEnvelopeRangeNode{index: 1, low: 0, high: studioEnvelopeChunk - 1}
	count, maxCount, visited := 1, 1, 0
	for count > 0 {
		count--
		node := stack[count]
		visited++
		if node.index < 1 || node.index >= 2*studioEnvelopeChunk {
			t.Fatal("tree index exceeds fixed storage")
		}
		if node.low == node.high {
			continue
		}
		mid := (node.low + node.high) / 2
		if count+2 > len(stack) {
			t.Fatal("independent complete traversal overflowed scratch")
		}
		stack[count], stack[count+1] = studioEnvelopeRangeNode{node.index*2 + 1, mid + 1, node.high}, studioEnvelopeRangeNode{node.index * 2, node.low, mid}
		count += 2
		maxCount = max(maxCount, count)
	}
	if visited != 2*studioEnvelopeChunk-1 || maxCount != studioEnvelopeScratchEntries {
		t.Fatal("scratch witness did not cover complete depth")
	}
	for _, invalid := range [][3]int{{-1, 0, 1}, {2, 0, 1}, {0, -1, 1}, {0, 1, 0}, {0, 0, studioEnvelopeChunk}} {
		got := studioGainEnvelope{iterative: true}
		got.insertRangeIterative(invalid[0], invalid[1], invalid[2], 0, .1, .2)
		if !got.invalid || got.bound(0) != 0 {
			t.Fatal("invalid range did not expose conservative failure")
		}
		got.resetHistory()
		if got.invalid || !got.iterative {
			t.Fatal("explicit epoch reset did not recover with same traversal")
		}
	}
	var got studioGainEnvelope
	got.iterative = true
	if allocations := testing.AllocsPerRun(3, func() { got.add(2047, 0, 384, 1026, .3); got.bound(2047) }); allocations != 0 {
		t.Fatal("iterative traversal allocated")
	}
	if got.invalid {
		t.Fatal("valid allocation fixture entered fallback")
	}
}
