package main

import (
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

const liveBlockFrames = 128

// liveMeterValues is the fixed float64 meter snapshot layout read by hosts:
// momentary, short-term and integrated LUFS, loudness range (LU), true-peak
// hold and recent true peak (dBTP), and recent maximum gain reduction (dB).
// Unavailable loudness readings are dsp.NoReading.
const liveMeterValues = 7

// liveBlockBridge owns a fixed-size channel ABI for the worker. Its scratch
// inputs preserve the JS bridge's validation/zero semantics without JS boxing.
// Every control and render path shares the same Bridge and DSP history.
type liveBlockBridge struct {
	bridge   *Bridge
	channels [4][liveBlockFrames]float32
	inputs   [2][liveBlockFrames]float32
	// The meter reads the processed output (channels 2/3) before host-side
	// A/B mixing or volume, so it reports what an export of these settings contains.
	meter    dsp.LoudnessMeter
	meterOut [liveMeterValues]float64
	recentGR float64
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
	b.syncMeterRate()
	b.meter.Process(b.channels[2][:], b.channels[3][:])
	b.recentGR = math.Max(b.recentGR, b.bridge.GainReductionDB())
	return liveBlockFrames
}

func (b *liveBlockBridge) syncMeterRate() {
	if rate := b.bridge.SampleRate(); b.meter.SampleRate() != rate {
		b.meter.Init(rate)
		b.recentGR = 0
	}
}

// meterSnapshot publishes the current readings into meterOut and restarts the
// recent-peak and recent gain-reduction intervals.
func (b *liveBlockBridge) meterSnapshot() uint32 {
	if b.bridge == nil {
		return 0
	}
	b.syncMeterRate()
	s := b.meter.Snapshot()
	b.meterOut = [liveMeterValues]float64{s.MomentaryLUFS, s.ShortTermLUFS, s.IntegratedLUFS, s.RangeLU, s.TruePeakDBTP, s.RecentPeakDBTP, b.recentGR}
	b.recentGR = 0
	return liveMeterValues
}

func (b *liveBlockBridge) reset() uint32 {
	if b.bridge == nil {
		return 0
	}
	b.bridge.Reset()
	b.syncMeterRate()
	b.meter.Reset()
	b.recentGR = 0
	return 1
}
