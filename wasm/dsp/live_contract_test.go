package main

import (
	"math"
	"testing"
)

func TestLiveContractCapabilities(t *testing.T) {
	if liveControlCount(1) != 81 || liveControlCount(2) != 82 {
		t.Fatal("packet ABI changed")
	}
	for _, abi := range []uint32{0, 3, math.MaxUint32} {
		if liveControlCount(abi) != 0 {
			t.Fatal("advertised unknown ABI")
		}
	}
	if liveAlgorithmSupported(1) != 1 {
		t.Fatal("missing legacy algorithm")
	}
	for _, version := range []uint32{0, 2, 3, math.MaxUint32} {
		if liveAlgorithmSupported(version) != 0 {
			t.Fatal("advertised an unimplemented algorithm")
		}
	}
}

func TestVersionedControlsMatchLegacyAndRejectAtomically(t *testing.T) {
	legacy := neutralLiveControls()
	legacy[3], legacy[6], legacy[31], legacy[32], legacy[40] = 2, -3, -20, 2, 20
	var vector liveVersionedControlVector
	copy(vector[:], legacy[:])
	vector[81] = 1
	left, right := NewBridge(48000), NewBridge(48000)
	if legacy.apply(left) != 1 || vector.apply(right, 82) != 1 {
		t.Fatal("valid controls rejected")
	}
	if right.Params().AlgorithmVersion != 1 || left.LatencyFrames() != 0 || right.LatencyFrames() != 0 {
		t.Fatal("incorrect version or latency")
	}
	var input, gotL, gotR, wantL, wantR [128]float32
	for i := range input {
		input[i] = float32(i%31-15) / 64
	}
	left.ProcessBlock(input[:], input[:], wantL[:], wantR[:])
	right.ProcessBlock(input[:], input[:], gotL[:], gotR[:])
	if gotL != wantL || gotR != wantR {
		t.Fatal("ABI 2 changed legacy PCM")
	}
	before := *right.engine
	for _, count := range []uint32{0, 81, 83, math.MaxUint32} {
		if vector.apply(right, count) != 0 || *right.engine != before {
			t.Fatal("wrong length changed history")
		}
	}
	for _, version := range []float64{0, 2, -1, 1.5, math.NaN(), math.Inf(1)} {
		bad := vector
		bad[81] = version
		if bad.apply(right, 82) != 0 || *right.engine != before {
			t.Fatal("invalid algorithm changed history")
		}
	}
	for index := range vector {
		bad := vector
		bad[index] = math.NaN()
		if bad.apply(right, 82) != 0 || *right.engine != before {
			t.Fatal("nonfinite control changed history")
		}
	}
	if vector.apply(nil, 82) != 0 {
		t.Fatal("accepted absent bridge")
	}
	if right.Drain(gotL[:], gotR[:]) != 0 || *right.engine != before {
		t.Fatal("drain advanced v1 history")
	}
	left.ProcessBlock(input[:], input[:], wantL[:], wantR[:])
	right.ProcessBlock(input[:], input[:], gotL[:], gotR[:])
	if gotL != wantL || gotR != wantR {
		t.Fatal("rejected packet changed next output")
	}
	if n := testing.AllocsPerRun(100, func() {
		vector.apply(right, 82)
		right.ProcessBlock(input[:], input[:], gotL[:], gotR[:])
		right.Drain(gotL[:], gotR[:])
	}); n != 0 {
		t.Fatalf("control/render allocated %g", n)
	}
}

func TestFrameCountsCannotWrapToSuccessfulLatency(t *testing.T) {
	if liveFrameCount(0) != 0 || liveFrameCount(128) != 128 || liveFrameCount(-1) != math.MaxUint32 {
		t.Fatal("unsafe frame count encoding")
	}
}
