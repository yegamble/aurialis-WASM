package main

import "math"

const liveBlockFrames = 128

// liveBlockBridge owns a fixed-size channel ABI for the worker. Its scratch
// inputs preserve the JS bridge's validation/zero semantics without JS boxing.
// Every control and render path shares the same Bridge and DSP history.
type liveBlockBridge struct {
	bridge   *Bridge
	channels [4][liveBlockFrames]float32
	inputs   [2][liveBlockFrames]float32
}

func (b *liveBlockBridge) buffer(channel uint32) *[liveBlockFrames]float32 {
	if channel >= uint32(len(b.channels)) {
		return nil
	}
	return &b.channels[channel]
}

func (b *liveBlockBridge) process() uint32 {
	if b.bridge == nil {
		return 0
	}
	for channel := 0; channel < 2; channel++ {
		for frame, sample := range b.channels[channel] {
			if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
				return 0
			}
			if sample == 0 {
				sample = 0 // Match syscall/js numeric transfer of negative zero.
			}
			b.inputs[channel][frame] = sample
		}
	}
	if !b.bridge.ProcessBlock(b.inputs[0][:], b.inputs[1][:], b.channels[2][:], b.channels[3][:]) {
		return 0
	}
	for channel := 2; channel < 4; channel++ {
		for frame, sample := range b.channels[channel] {
			if sample == 0 {
				b.channels[channel][frame] = 0
			}
		}
	}
	return liveBlockFrames
}

func (b *liveBlockBridge) reset() uint32 {
	if b.bridge == nil {
		return 0
	}
	b.bridge.Reset()
	return 1
}
