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
	// The source's input ends endAt-1 frames into the next block (0: not yet
	// known). At that frame the bridge drains the lookahead tail an export
	// render would (dsp.Engine.DrainDetached) into tail, without disturbing the
	// engine, which keeps processing the input. The worklet plays the tail in
	// place of the engine's frames while the pass is still finite, so a file
	// that ends loud renders the same final frames live as exported (V1-13);
	// if Repeat comes back on (resumeInput) it plays the engine's continuous
	// output instead, with no gap and no cold reset. The meter reads the tail
	// and then silence, as a finite pass sounds.
	endAt           int
	ended           bool
	tail            [2][liveTailFrames]float32
	tailLen, tailAt int
	metered         [2][liveBlockFrames]float32
}

// liveTailFrames bounds the drained pipeline (v2 has at most 334 frames;
// algorithm 3 adds 64 FIR frames, totaling 398 at 192 kHz).
const liveTailFrames = 512

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
	if !b.render() {
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
	b.meter.Process(b.metered[0][:], b.metered[1][:])
	b.recentGR = math.Max(b.recentGR, b.bridge.GainReductionDB())
	return liveBlockFrames
}

// render processes the scratch inputs into channels 2/3, draining the tail
// at the source's end; the meter reads the tail, then silence.
func (b *liveBlockBridge) render() bool {
	outL, outR := b.channels[2][:], b.channels[3][:]
	split := liveBlockFrames
	if b.endAt > 0 {
		split, b.endAt = b.endAt-1, 0
	}
	if split > 0 && !b.bridge.ProcessBlock(b.inputs[0][:split], b.inputs[1][:split], outL[:split], outR[:split]) {
		return false
	}
	if split < liveBlockFrames {
		b.ended, b.tailAt = true, 0
		b.tailLen = b.bridge.DrainDetached(b.tail[0][:], b.tail[1][:])
		if !b.bridge.ProcessBlock(b.inputs[0][split:], b.inputs[1][split:], outL[split:], outR[split:]) {
			return false
		}
	}
	copy(b.metered[0][:], outL)
	copy(b.metered[1][:], outR)
	if !b.ended {
		return true
	}
	from := 0
	if split < liveBlockFrames {
		from = split
	}
	for frame := from; frame < liveBlockFrames; frame++ {
		b.metered[0][frame], b.metered[1][frame] = 0, 0
		if b.tailAt < b.tailLen {
			b.metered[0][frame], b.metered[1][frame] = b.tail[0][b.tailAt], b.tail[1][b.tailAt]
			b.tailAt++
		}
	}
	return true
}

// tailBuffer exposes one channel of the drained tail (0 left, 1 right).
func (b *liveBlockBridge) tailBuffer(channel uint32) *[liveTailFrames]float32 {
	if channel >= uint32(len(b.tail)) {
		return nil
	}
	return &b.tail[channel]
}

// tailFrames reports the drained tail's length, or 0 before a source end.
func (b *liveBlockBridge) tailFrames() uint32 {
	if !b.ended {
		return 0
	}
	return liveFrameCount(b.tailLen)
}

// endInput marks where the source's input ends in the next block: frame
// offset 0–128, where 128 means after it. It returns 0 for other offsets or
// a second mark before reset or resumeInput.
func (b *liveBlockBridge) endInput(offset uint32) uint32 {
	if b.bridge == nil || offset > liveBlockFrames || b.ended || b.endAt > 0 {
		return 0
	}
	b.endAt = int(offset) + 1
	return 1
}

// resumeInput cancels the source end (Repeat turned back on): the engine,
// which never stopped processing the input, plays from the next block, and
// the meter reads it again.
func (b *liveBlockBridge) resumeInput() uint32 {
	if b.bridge == nil {
		return 0
	}
	b.endAt, b.ended, b.tailLen, b.tailAt = 0, false, 0, 0
	return 1
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
	b.endAt, b.ended, b.tailLen, b.tailAt = 0, false, 0, 0
	b.syncMeterRate()
	b.meter.Reset()
	b.recentGR = 0
	return 1
}
