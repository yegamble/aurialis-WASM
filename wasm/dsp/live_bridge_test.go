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

func TestLiveMeterReadsProcessedOutputAndGainReduction(t *testing.T) {
	b := liveBlockBridge{bridge: NewBridge(48000)}
	params := dsp.DefaultParams()
	params.InputGainDB = -6
	params.Compressor.ThresholdDB = -40
	params.Compressor.Ratio = 4
	b.bridge.engine.SetParams(params)
	amp := math.Pow(10, -14.0/20)
	for block := 0; block < 48000*4/128; block++ {
		for i := range liveBlockFrames {
			v := float32(amp * math.Sin(2*math.Pi*1000*float64(block*liveBlockFrames+i)/48000))
			b.channels[0][i], b.channels[1][i] = v, v
		}
		if b.process() != 128 {
			t.Fatal("process rejected the tone")
		}
	}
	if b.meterSnapshot() != liveMeterValues {
		t.Fatal("meter snapshot was not written")
	}
	momentary, shortTerm, integrated, _, hold, recent, reduction := b.meterOut[0], b.meterOut[1], b.meterOut[2], b.meterOut[3], b.meterOut[4], b.meterOut[5], b.meterOut[6]
	offline := dsp.MeasureStereo(b.channels[2][:], b.channels[3][:], 48000)
	if momentary > -20 || momentary < -40 || shortTerm == dsp.NoReading || integrated == dsp.NoReading || reduction < 10 {
		t.Fatalf("meter did not follow the compressed output: %v", b.meterOut)
	}
	// The hold keeps the -20 dBFS onset (already slightly reduced by the attack).
	if hold > -19.9 || hold < -21 || recent != hold || recent < offline.TruePeakDBTP {
		t.Fatalf("true-peak hold %.2f / recent %.2f, last block %.2f", hold, recent, offline.TruePeakDBTP)
	}
	if b.meterSnapshot(); b.meterOut[6] != 0 || b.meterOut[5] > -200 {
		t.Fatalf("recent intervals did not restart: %v", b.meterOut)
	}
	if b.reset() != 1 || b.meterSnapshot() != liveMeterValues || b.meterOut[2] != dsp.NoReading || b.meterOut[4] > -200 {
		t.Fatalf("reset kept meter history: %v", b.meterOut)
	}
	var uninitialized liveBlockBridge
	if uninitialized.meterSnapshot() != 0 {
		t.Fatal("uninitialized bridge published a meter snapshot")
	}
}

// aurialis_live_end_input accepts one offset in 0–128 per stream; reset or
// aurialis_live_resume_input clears it. The engine output never changes: the
// mark only drains the lookahead tail an export would, for the worklet to
// play while the pass is finite. The tail limits against silence, so near
// the ceiling it differs from the engine, which limits against more input.
func TestLiveEndInputDrainsLikeAnExport(t *testing.T) {
	p := dsp.DefaultParams()
	p.AlgorithmVersion, p.InputGainDB = dsp.TruePeakAlgorithmVersion, 6
	p.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -9, ReleaseMS: 80, TruePeak: true}
	marked, plain := liveBlockBridge{bridge: NewBridge(48000)}, liveBlockBridge{bridge: NewBridge(48000)}
	for _, b := range []*liveBlockBridge{&marked, &plain} {
		if !b.bridge.SetParams(p) || b.reset() != 1 {
			t.Fatal("settings rejected")
		}
	}
	if marked.endInput(liveBlockFrames+1) != 0 || marked.tailFrames() != 0 {
		t.Fatal("offset past the quantum accepted, or a tail before the end")
	}
	if marked.endInput(5) != 1 || marked.endInput(6) != 0 {
		t.Fatal("end not accepted exactly once")
	}
	latency := marked.bridge.LatencyFrames()
	var engine [2][]float32
	for block := 0; block < 4; block++ {
		for _, b := range []*liveBlockBridge{&marked, &plain} {
			for frame := range liveBlockFrames {
				b.channels[0][frame] = float32(0.9 * math.Sin(float64(block*liveBlockFrames+frame)/7))
				b.channels[1][frame] = b.channels[0][frame]
			}
			if b.process() != liveBlockFrames {
				t.Fatal("block rejected")
			}
		}
		if marked.channels[2] != plain.channels[2] || marked.channels[3] != plain.channels[3] {
			t.Fatalf("block %d: the mark changed the engine output", block)
		}
		engine[0] = append(engine[0], plain.channels[2][:]...)
	}
	if int(marked.tailFrames()) != latency {
		t.Fatalf("tail %d frames, want the %d-frame lookahead", marked.tailFrames(), latency)
	}
	differs := false
	for i := range latency {
		differs = differs || marked.tail[0][i] != engine[0][5+i]
	}
	if !differs {
		t.Fatal("the drained tail matched the continuing engine; the fixture does not limit at the end")
	}
	if marked.resumeInput() != 1 || marked.tailFrames() != 0 || marked.endInput(0) != 1 || marked.reset() != 1 || marked.endInput(0) != 1 {
		t.Fatal("resume or reset did not clear the end")
	}
}

// V1-13 Round E 2 S-b2: Repeat turned back on after the source's end was
// marked continues the loop with no gap and no reset. The engine never stopped
// processing the looping input, so its output equals a stream that was never
// marked, and after resume the tail is gone, so the worklet plays that output.
func TestLiveResumeAfterTheEndMarkContinuesTheLoop(t *testing.T) {
	const rate = 48000.0
	p := dsp.DefaultParams()
	p.AlgorithmVersion, p.InputGainDB = dsp.TruePeakAlgorithmVersion, 9
	p.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -9, ReleaseMS: 80, TruePeak: true}
	loop, _ := denseMix(rate, 1)
	frames := len(loop)
	resumeBlock := (frames + int(0.04*rate)) / liveBlockFrames
	marked, plain := liveBlockBridge{bridge: NewBridge(rate)}, liveBlockBridge{bridge: NewBridge(rate)}
	for _, b := range []*liveBlockBridge{&marked, &plain} {
		if !b.bridge.SetParams(p) || b.reset() != 1 {
			t.Fatal("settings rejected")
		}
	}
	for block := 0; block < (2*frames)/liveBlockFrames; block++ {
		start := block * liveBlockFrames
		if start <= frames && frames < start+liveBlockFrames && marked.endInput(liveFrameCount(frames-start)) != 1 {
			t.Fatal("end rejected")
		}
		if block == resumeBlock && (marked.resumeInput() != 1 || marked.tailFrames() != 0) {
			t.Fatal("resume kept the tail")
		}
		for _, b := range []*liveBlockBridge{&marked, &plain} {
			for frame := range liveBlockFrames {
				b.channels[0][frame] = loop[(start+frame)%frames] // the source loops on
				b.channels[1][frame] = b.channels[0][frame]
			}
			if b.process() != liveBlockFrames {
				t.Fatal("block rejected")
			}
		}
		if marked.channels[2] != plain.channels[2] || marked.channels[3] != plain.channels[3] {
			t.Fatalf("block %d (source end in block %d, resume in %d) differs from the unmarked loop", block, frames/liveBlockFrames, resumeBlock)
		}
	}
}
