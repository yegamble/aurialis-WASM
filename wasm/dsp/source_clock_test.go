// cspell:words automator

package main

import (
	"context"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func staticEpochParams() dsp.Params {
	params := dsp.DefaultParams()
	params.Bands[2].GainDB = 3
	params.Compressor.ThresholdDB = -18
	params.Compressor.Ratio = 2
	params.Saturation.Amount = 15
	return params
}
func epochInputs(start, count int) ([]float32, []float32) {
	left, right := make([]float32, count), make([]float32, count)
	for i := range left {
		left[i] = float32((start+i)*73%997-498) / 1024
		right[i] = float32((start+i)*31%991-495) / 1024
	}
	return left, right
}
func checkEpochPCM(t *testing.T, gotL, gotR, wantL, wantR []float32) {
	t.Helper()
	for i := range gotL {
		if gotL[i] != wantL[i] || gotR[i] != wantR[i] {
			t.Fatalf("PCM diverged at frame%d got%.9g/%.9g want%.9g/%.9g", i, gotL[i], gotR[i], wantL[i], wantR[i])
		}
	}
}
func epochSchedule(t *testing.T, source sourceBinding, rate int, params dsp.Params) *automation.Schedule {
	t.Helper()
	schedule, err := automation.CompileContext(context.Background(), source.rate, rate, source.frames, 1, automator.ValuesOf(params), []automation.Move{{ID: "gain", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: source.frames, Value: 6}}}})
	if err != nil {
		t.Fatal(err)
	}
	return schedule
}

func TestBindSourceMetadataDoesNotResetStaticDSPHistory(t *testing.T) {
	bridge := NewBridge(48000)
	params := staticEpochParams()
	bridge.SetParams(params)
	left, right := epochInputs(0, 257)
	outL, outR := make([]float32, 257), make([]float32, 257)
	bridge.ProcessBlock(left, right, outL, outR)
	before := *bridge.engine
	source := sourceBinding{rate: 44100, frames: 48001, hash: [8]uint32{1}}
	if !bridge.bindSource(source) || *bridge.engine != before {
		t.Fatal("binding metadata reset audible static history")
	}
	bridge.setScheduleLooping(true)
	bridge.ProcessBlock(left, right, outL, outR)
	clockBefore, engineBefore := bridge.sourceClock, *bridge.engine
	if !bridge.bindSource(source) || bridge.sourceClock != clockBefore || *bridge.engine != engineBefore {
		t.Fatal("same-identity bind changed clock/history")
	}
	invalid := source
	invalid.rate = 0
	if bridge.bindSource(invalid) || bridge.sourceClock != clockBefore || *bridge.engine != engineBefore {
		t.Fatal("failed binding changed state")
	}
}

func TestFirstApplyInheritsStaticFractionalPhaseAndHistory(t *testing.T) {
	for _, rates := range []struct{ source, device int }{{44100, 48000}, {48000, 44100}, {8001, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129, 48001} {
			for _, fragments := range [][]int{{128}, {1, 33, 127, 128, 129, 41}} {
				source := sourceBinding{rate: rates.source, frames: frames, hash: [8]uint32{1}}
				params := staticEpochParams()
				bridge := NewBridge(float64(rates.device))
				bridge.SetParams(params)
				if !bridge.bindSource(source) || !bridge.setScheduleLooping(true) || !bridge.seekSchedule(frames/3) {
					t.Fatal("detached source epoch rejected")
				}
				reference := dsp.NewEngine(float64(rates.device))
				reference.SetParams(params)
				reference.Reset()
				schedule := epochSchedule(t, source, rates.device, params)
				total := 0
				for _, count := range fragments {
					left, right := epochInputs(total, count)
					gotL, gotR, wantL, wantR := make([]float32, count), make([]float32, count), make([]float32, count), make([]float32, count)
					bridge.ProcessBlock(left, right, gotL, gotR)
					reference.ProcessBlock(left, right, wantL, wantR)
					checkEpochPCM(t, gotL, gotR, wantL, wantR)
					total += count
				}
				clockBefore, engineBefore := bridge.sourceClock, *bridge.engine
				if !bridge.bindSource(source) || bridge.sourceClock != clockBefore || *bridge.engine != engineBefore {
					t.Fatal("idempotent bind disturbed running source")
				}
				install(t, bridge, source, params, schedule, 1)
				if *bridge.engine != engineBefore || bridge.sourceClock != clockBefore {
					t.Fatal("first Apply reset DSP or transport phase")
				}
				for _, count := range []int{1, 127, 128, 129, 257} {
					left, right := epochInputs(total, count)
					gotL, gotR, wantL, wantR := make([]float32, count), make([]float32, count), make([]float32, count), make([]float32, count)
					gain := make([]float64, count)
					for i := range gain {
						numerator := (frames/3*int64(rates.device) + int64(total+i)*int64(rates.source)) % (frames * int64(rates.device))
						gain[i] = schedule.ValueAt(automation.InputGain, float64(numerator)/float64(rates.device))
					}
					if !bridge.ProcessBlock(left, right, gotL, gotR) || !reference.ProcessAutomationBlock(left, right, wantL, wantR, gain, nil) {
						t.Fatal("first Apply processing rejected")
					}
					checkEpochPCM(t, gotL, gotR, wantL, wantR)
					total += count
				}
			}
		}
	}
}

func TestBoundClockDetachSeekResetAndRejectedPublication(t *testing.T) {
	source := sourceBinding{rate: 48000, frames: 129, hash: [8]uint32{1}}
	params := staticEpochParams()
	bridge := NewBridge(44100)
	bridge.SetParams(params)
	bridge.bindSource(source)
	if !bridge.setScheduleLooping(true) || !bridge.seekSchedule(123) {
		t.Fatal("detached seek/loop unavailable")
	}
	left, right := epochInputs(0, 33)
	outL, outR := make([]float32, 33), make([]float32, 33)
	bridge.ProcessBlock(left, right, outL, outR)
	before := bridge.sourceClock
	history := *bridge.engine
	if bridge.seekSchedule(-1) || bridge.sourceClock != before || *bridge.engine != history {
		t.Fatal("failed detached seek changed state")
	}
	wrong := source
	wrong.hash[0]++
	if bridge.beginSchedule(wrong, 1, 0, params) || bridge.sourceClock != before || *bridge.engine != history {
		t.Fatal("failed begin changed phase")
	}
	if !bridge.beginSchedule(source, 1, 1, params) || bridge.stageScheduleMove(0, automation.InputGain, 0, false, []automation.Point{{Frame: 0, Value: math.NaN()}, {Frame: 129, Value: 0}}) || bridge.commitSchedule() || bridge.sourceClock != before || *bridge.engine != history {
		t.Fatal("failed first publication changed phase/history")
	}
	schedule := epochSchedule(t, source, 44100, params)
	install(t, bridge, source, params, schedule, 1)
	bridge.ProcessBlock(left, right, outL, outR)
	before = bridge.sourceClock
	if !bridge.detachSchedule() || bridge.sourceClock != before {
		t.Fatal("detach lost phase")
	}
	bridge.ProcessBlock(left[:17], right[:17], outL[:17], outR[:17])
	expected := before
	expected.AdvanceFrames(17)
	if bridge.sourceClock != expected {
		t.Fatal("detached partial block lost phase")
	}
	install(t, bridge, source, params, schedule, 2)
	before = bridge.sourceClock
	history = *bridge.engine
	if bridge.beginSchedule(source, 1, 0, params) || !bridge.bindSource(source) || bridge.sourceClock != before || *bridge.engine != history || bridge.scheduleRevision() != 2 {
		t.Fatal("stale publication/rebind disturbed active source")
	}
	wrong = source
	wrong.hash[0]++
	if bridge.bindSource(wrong) || bridge.sourceClock != before || *bridge.engine != history {
		t.Fatal("different source rebound while attached")
	}
	bridge.Reset()
	if !bridge.sourceBound || bridge.source != source || bridge.scheduleRevision() != 2 {
		t.Fatal("reset discarded identity or revision")
	}
	expected, _ = automation.NewSourceClock(48000, 44100, 129)
	expected.SetLooping(true)
	if bridge.sourceClock != expected {
		t.Fatal("reset did not seek0 while retaining loop mode")
	}
	bridge.detachSchedule()
	if !bridge.seekSchedule(99) {
		t.Fatal("seek after detach rejected")
	}
	before = bridge.sourceClock
	bridge.ProcessBlock(nil, nil, nil, nil)
	if bridge.sourceClock != before {
		t.Fatal("paused/no frames advanced clock")
	}
}

func TestBoundClockAdvancesWhileStaticBypassedAndWithoutAllocations(t *testing.T) {
	bridge := NewBridge(44100)
	source := sourceBinding{rate: 48000, frames: 129, hash: [8]uint32{1}}
	bridge.bindSource(source)
	bridge.setScheduleLooping(true)
	params := staticEpochParams()
	params.Bypass = true
	bridge.SetParams(params)
	var left, right, outL, outR [128]float32
	left[0] = .25
	before := bridge.sourceClock
	if !bridge.ProcessBlock(left[:], right[:], outL[:], outR[:]) || outL[0] != .25 {
		t.Fatal("static bypass changed PCM")
	}
	before.AdvanceFrames(128)
	if bridge.sourceClock != before {
		t.Fatal("bypass paused source clock")
	}
	if allocations := testing.AllocsPerRun(100, func() { bridge.ProcessBlock(left[:], right[:], outL[:], outR[:]) }); allocations != 0 {
		t.Fatal("bound static processing allocated", allocations)
	}
}

func TestDetachAtFractionalLoopSeamPreservesStaticAndReapplyPhase(t *testing.T) {
	for _, rates := range []struct{ source, device int }{{8001, 44100}, {48000, 44100}} {
		for _, frames := range []int64{1, 127, 129} {
			source := sourceBinding{rate: rates.source, frames: frames, hash: [8]uint32{1}}
			params := staticEpochParams()
			schedule := epochSchedule(t, source, rates.device, params)
			bridge := NewBridge(float64(rates.device))
			bridge.bindSource(source)
			bridge.setScheduleLooping(true)
			install(t, bridge, source, params, schedule, 1)
			reference := dsp.NewEngine(float64(rates.device))
			reference.SetParams(params)
			total := 0
			period := frames * int64(rates.device)
			render := func(count int, automated bool) {
				left, right := epochInputs(total, count)
				gotL, gotR, wantL, wantR := make([]float32, count), make([]float32, count), make([]float32, count), make([]float32, count)
				if !bridge.ProcessBlock(left, right, gotL, gotR) {
					t.Fatal("bridge rejected")
				}
				if automated {
					gain := make([]float64, count)
					for i := range gain {
						phase := int64(total+i) * int64(rates.source) % period
						gain[i] = schedule.ValueAt(automation.InputGain, float64(phase)/float64(rates.device))
					}
					reference.ProcessAutomationBlock(left, right, wantL, wantR, gain, nil)
				} else {
					reference.ProcessBlock(left, right, wantL, wantR)
				}
				checkEpochPCM(t, gotL, gotR, wantL, wantR)
				total += count
			}
			seamCount := int((period + int64(rates.source) - 1) / int64(rates.source))
			render(seamCount, true)
			if !bridge.detachSchedule() {
				t.Fatal("detach rejected at loop seam")
			}
			render(17, false)
			install(t, bridge, source, params, schedule, 2)
			render(129, true)
		}
	}
}
