package main

import (
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestLiveBlockBuffersAndNeutralZeros(t *testing.T) {
	b := liveBlockBridge{bridge: NewBridge(48000)}
	for channel := uint32(0); channel < 4; channel++ {
		if b.buffer(channel) != &b.channels[channel] {
			t.Fatalf("channel %d does not expose its fixed buffer", channel)
		}
	}
	if b.buffer(4) != nil || b.buffer(math.MaxUint32) != nil {
		t.Fatal("invalid channel exposed memory")
	}
	left := b.buffer(0)
	b.channels[0][0] = float32(math.Copysign(0, -1))
	b.channels[0][127] = 0.125
	b.channels[1][127] = -0.25
	if b.process() != 128 || math.Signbit(float64(b.channels[2][0])) || b.channels[2][127] != 0.125 || b.channels[3][127] != -0.25 {
		t.Fatal("neutral live block changed samples or zero semantics")
	}
	if !math.Signbit(float64(b.channels[0][0])) {
		t.Fatal("render changed the caller's input buffer")
	}
	b.bridge.Init(96000)
	if b.reset() != 1 || b.buffer(0) != left {
		t.Fatal("initialization/reset moved a fixed buffer")
	}
	var uninitialized liveBlockBridge
	if uninitialized.process() != 0 || uninitialized.reset() != 0 {
		t.Fatal("uninitialized bridge accepted processing")
	}
}

func TestLiveBlockRejectsWithoutChangingOutputsOrHistory(t *testing.T) {
	b := liveBlockBridge{bridge: NewBridge(44100)}
	params := dsp.DefaultParams()
	params.Compressor.Ratio = 3
	params.Compressor.ThresholdDB = -24
	params.Saturation.Amount = 30
	params.Saturation.Character = dsp.SatCrisp
	b.bridge.SetParams(params)
	for channel := 0; channel < 2; channel++ {
		for i := range b.channels[channel] {
			b.channels[channel][i] = float32(0.2 * math.Sin(float64(i+channel)*0.31))
		}
	}
	if b.process() != 128 {
		t.Fatal("initial valid block rejected")
	}
	state := *b.bridge.engine
	reference := NewBridge(44100)
	*reference.engine = state
	for _, value := range []float32{float32(math.NaN()), float32(math.Inf(1)), float32(math.Inf(-1))} {
		for channel := 0; channel < 2; channel++ {
			previous := b.channels[channel][127]
			b.channels[channel][127] = value
			beforeL, beforeR := b.channels[2], b.channels[3]
			if b.process() != 0 || b.channels[2] != beforeL || b.channels[3] != beforeR {
				t.Fatal("invalid input processed or touched outputs")
			}
			b.channels[channel][127] = previous
		}
	}
	var expectedL, expectedR [128]float32
	reference.ProcessBlock(b.channels[0][:], b.channels[1][:], expectedL[:], expectedR[:])
	if b.process() != 128 || b.channels[2] != expectedL || b.channels[3] != expectedR {
		t.Fatal("rejected input advanced DSP history")
	}
}

func TestLiveBlockSharesControlsResetAndZeroAllocations(t *testing.T) {
	b := liveBlockBridge{bridge: NewBridge(48000)}
	params := dsp.DefaultParams()
	params.InputGainDB = 6
	params.Saturation.Amount = 40
	params.Saturation.Character = dsp.SatCrisp
	params.Compressor.Ratio = 3
	params.Compressor.ThresholdDB = -20
	params.Limiter.Enabled = true
	params.Stereo.MonoBass = true
	b.bridge.SetParams(params)
	for i := range b.channels[0] {
		b.channels[0][i] = float32(math.Sin(float64(i)*0.2) * 0.2)
		b.channels[1][i] = b.channels[0][i]
	}
	if b.process() != 128 {
		t.Fatal("configured block rejected")
	}
	firstL, firstR := b.channels[2], b.channels[3]
	if b.reset() != 1 || b.process() != 128 || b.channels[2] != firstL || b.channels[3] != firstR {
		t.Fatal("direct reset did not reset shared DSP history")
	}
	b.bridge.Reset()
	var expectedL, expectedR [128]float32
	b.bridge.ProcessBlock(b.channels[0][:], b.channels[1][:], expectedL[:], expectedR[:])
	b.reset()
	if b.process() != 128 || b.channels[2] != expectedL || b.channels[3] != expectedR {
		t.Fatal("direct and existing block APIs do not share controls/reset")
	}
	if allocations := testing.AllocsPerRun(100, func() { b.process() }); allocations != 0 {
		t.Fatalf("direct live block allocates %v times", allocations)
	}
}
