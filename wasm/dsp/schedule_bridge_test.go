// cspell:words automator

package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func scheduleFixture(t *testing.T, rate int) (sourceBinding, dsp.Params, *automation.Schedule) {
	t.Helper()
	source := sourceBinding{rate: 48000, frames: 48000, hash: [8]uint32{1, 2, 3, 4, 5, 6, 7, 8}}
	params := dsp.DefaultParams()
	params.Limiter.Enabled = true
	params.Limiter.CeilingDBTP = -1
	moves := []automation.Move{
		{ID: "gain", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: 48000, Value: 3}}},
		{ID: "width", Target: "stereo.widthPct", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 100}, {Frame: 48000, Value: 180}}},
		{ID: "eq", Target: "eq.2.gainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: 24000, Value: .8}, {Frame: 48000, Value: 0}}},
	}
	schedule, err := automation.CompileContext(context.Background(), source.rate, rate, source.frames, 1, automator.ValuesOf(params), moves)
	if err != nil {
		t.Fatal(err)
	}
	return source, params, schedule
}
func install(t *testing.T, bridge *Bridge, source sourceBinding, params dsp.Params, schedule *automation.Schedule, revision uint64) {
	t.Helper()
	if !bridge.beginSchedule(source, revision, len(schedule.NumericMoves()), params) {
		t.Fatal("begin failed")
	}
	for i, move := range schedule.NumericMoves() {
		if !bridge.stageScheduleMove(i, move.Target, move.FadeFrames, move.Muted, move.Points) {
			t.Fatal("stage failed")
		}
	}
	if !bridge.commitSchedule() {
		t.Fatal("commit failed")
	}
}
func TestScheduleBridgeAtomicityRevisionSeekAndBaseline(t *testing.T) {
	source, params, schedule := scheduleFixture(t, 48000)
	bridge := NewBridge(48000)
	if !bridge.bindSource(source) {
		t.Fatal("bind failed")
	}
	install(t, bridge, source, params, schedule, 1)
	var left, right, outL, outR [128]float32
	for i := range left {
		left[i] = .25
		right[i] = -.15
	}
	bridge.ProcessBlock(left[:], right[:], outL[:], outR[:])
	before := *bridge.engine
	invalid := source
	invalid.hash[0]++
	if bridge.beginSchedule(invalid, 2, 0, params) || bridge.beginSchedule(source, 1, 0, params) || bridge.SetParams(params) || bridge.SetBand(0, params.Bands[0]) || bridge.SetParamsJSON(`{"inputGainDb":1}`) == nil || *bridge.engine != before {
		t.Fatal("invalid/stale/source-mismatched/static update changed active DSP")
	}
	if !bridge.beginSchedule(source, 2, 1, params) || bridge.stageScheduleMove(0, automation.InputGain, 0, false, []automation.Point{{Frame: 0, Value: math.NaN()}, {Frame: 100, Value: 0}}) || bridge.commitSchedule() || *bridge.engine != before {
		t.Fatal("incomplete/invalid schedule changed active engine")
	}
	if bridge.seekSchedule(-1) || *bridge.engine != before {
		t.Fatal("invalid seek changed history")
	}
	if !bridge.seekSchedule(123) {
		t.Fatal("valid seek failed")
	}
	baseline := params
	baseline.InputGainDB = -1
	newSchedule, err := automation.CompileContext(context.Background(), 48000, 48000, 48000, 2, automator.ValuesOf(baseline), nil)
	if err != nil {
		t.Fatal(err)
	}
	install(t, bridge, source, baseline, newSchedule, 2)
	if bridge.scheduleRevision() != 2 || bridge.Params().InputGainDB != -1 {
		t.Fatal("baseline and revision were not installed together")
	}
	if !bridge.detachSchedule() || !bridge.SetParams(params) {
		t.Fatal("detach did not permit static controls")
	}
}
func TestScheduleBridgeRenderMatchesSharedEvaluator(t *testing.T) {
	for _, rate := range []int{8000, 44100, 48000, 192000} {
		source, params, schedule := scheduleFixture(t, rate)
		bridge := NewBridge(float64(rate))
		bridge.bindSource(source)
		install(t, bridge, source, params, schedule, 1)
		processor, err := automator.New(dsp.NewEngine(float64(rate)), params, schedule)
		if err != nil {
			t.Fatal(err)
		}
		var left, right, gotL, gotR, wantL, wantR [128]float32
		for block := 0; block < 60; block++ {
			for i := range left {
				left[i] = float32((block*128+i)*73%997-498) / 1024
				right[i] = float32((block*128+i)*31%991-495) / 1024
			}
			bridge.ProcessBlock(left[:], right[:], gotL[:], gotR[:])
			processor.ProcessBlock(left[:], right[:], wantL[:], wantR[:])
			if gotL != wantL || gotR != wantR {
				t.Fatal("bridge schedule diverged from common evaluator")
			}
		}
	}
}
func TestWriteAutomationParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_AUTOMATION_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_AUTOMATION_FIXTURE for actual compiled-WASI parity")
	}
	type fixture struct {
		PublicProfile                        bool                     `json:"publicProfile"`
		Looping                              bool                     `json:"looping"`
		Seek                                 int64                    `json:"seek"`
		Rate                                 int                      `json:"rate"`
		SourceRate                           int                      `json:"sourceRate"`
		Frames                               int64                    `json:"frames"`
		Params                               dsp.Params               `json:"params"`
		Moves                                []automation.NumericMove `json:"moves"`
		Left, Right, OutputLeft, OutputRight []float32
	}
	fixtures := []fixture{}
	for _, algorithm := range []uint32{dsp.LegacyAlgorithmVersion, dsp.OversampledAlgorithmVersion} {
		for _, rate := range []int{8000, 44100, 48000, 192000} {
			source, params, schedule := scheduleFixture(t, rate)
			params.AlgorithmVersion = algorithm
			for _, seek := range []int64{0, 123, 24000} {
				processor, err := automator.New(dsp.NewEngine(float64(rate)), params, schedule)
				if err != nil {
					t.Fatal(err)
				}
				if err := processor.SeekSourceFrame(seek); err != nil {
					t.Fatal(err)
				}
				const count = 4096
				item := fixture{Seek: seek, Rate: rate, SourceRate: source.rate, Frames: source.frames, Params: params, Moves: schedule.NumericMoves(), Left: make([]float32, count), Right: make([]float32, count), OutputLeft: make([]float32, count), OutputRight: make([]float32, count)}
				for i := range count {
					item.Left[i] = float32(i*73%997-498) / 1024
					item.Right[i] = float32(i*31%991-495) / 1024
				}
				for start := 0; start < count; start += 128 {
					processor.ProcessBlock(item.Left[start:start+128], item.Right[start:start+128], item.OutputLeft[start:start+128], item.OutputRight[start:start+128])
				}
				fixtures = append(fixtures, item)
			}
		}
	}
	for _, pair := range []struct{ source, device int }{{8001, 44100}, {48000, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129, 8001} {
			params := dsp.DefaultParams()
			params.Bands[2].GainDB = 3
			moves := []automation.Move{{ID: "loop-gain", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: frames, Value: 3}}}}
			schedule, err := automation.CompileContext(context.Background(), pair.source, pair.device, frames, 1, automator.ValuesOf(params), moves)
			if err != nil {
				t.Fatal(err)
			}
			processor, err := automator.New(dsp.NewEngine(float64(pair.device)), params, schedule)
			if err != nil {
				t.Fatal(err)
			}
			processor.SetLooping(true)
			if err := processor.SeekSourceFrame(frames - 1); err != nil {
				t.Fatal(err)
			}
			const count = 4096
			item := fixture{Looping: true, Seek: frames - 1, Rate: pair.device, SourceRate: pair.source, Frames: frames, Params: params, Moves: schedule.NumericMoves(), Left: make([]float32, count), Right: make([]float32, count), OutputLeft: make([]float32, count), OutputRight: make([]float32, count)}
			for i := range count {
				item.Left[i] = float32(i*73%997-498) / 1024
				item.Right[i] = float32(i*31%991-495) / 1024
			}
			for start := 0; start < count; start += 128 {
				if !processor.ProcessBlock(item.Left[start:start+128], item.Right[start:start+128], item.OutputLeft[start:start+128], item.OutputRight[start:start+128]) {
					t.Fatal("loop rejected")
				}
			}
			fixtures = append(fixtures, item)
		}
	}

	for _, profile := range []mastering.ProfileID{mastering.ProfileWarmAnalog, mastering.ProfilePunchyCommercial, mastering.ProfileDynamicOpen, mastering.ProfileVocalForward, mastering.ProfileBassHeavy} {
		const count = 4096
		buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: count, Duration: float64(count) / 48000, Left: make([]float32, count), Right: make([]float32, count)}
		for i := range count {
			buf.Left[i] = float32(i*73%997-498) / 1024
			buf.Right[i] = float32(i*31%991-495) / 1024
		}
		script, _, err := mastering.AnalyzeDeepV2Context(context.Background(), buf, profile, nil)
		if err != nil {
			t.Fatal(err)
		}
		schedule, err := mastering.ValidateScriptV2Context(context.Background(), script, 48000)
		if err != nil {
			t.Fatal(err)
		}
		left, right, _, err := mastering.RenderScriptV2Context(context.Background(), buf, script)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, fixture{PublicProfile: true, Rate: 48000, SourceRate: 48000, Frames: count, Params: script.ChainParams, Moves: schedule.NumericMoves(), Left: buf.Left, Right: buf.Right, OutputLeft: left, OutputRight: right})
	}

	data, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Test-only artifact path supplied by the local parity harness, never an upload or HTTP request.
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestScheduleNumericVectorsRejectNonIntegralAndInvalidLayouts(t *testing.T) {
	vector := scheduleSourceVector{1, 48000, 48000, 1, 2, 3, 4, 5, 6, 7, 8}
	binding, ok := vector.binding()
	if !ok {
		t.Fatal("valid source vector rejected")
	}
	bridge := NewBridge(48000)
	bridge.bindSource(binding)
	params := dsp.DefaultParams()
	if !bridge.beginSchedule(binding, 1, 1, params) {
		t.Fatal("begin failed")
	}
	move := scheduleMoveVector{0, 2, 0, 0, 0, 0, 100, 1}
	if !move.stage(bridge, 0) {
		t.Fatal("valid move vector rejected")
	}
	for _, bad := range []float64{math.NaN(), math.Inf(1), 1.5, -1} {
		copyVector := vector
		copyVector[2] = bad
		if _, ok := copyVector.binding(); ok {
			t.Fatal("invalid integer source accepted")
		}
		copyMove := move
		copyMove[1] = bad
		if copyMove.stage(bridge, 0) {
			t.Fatal("invalid point count accepted")
		}
	}
}

func TestNumericStageAndAtomicRevisionPublicationAllocateNothing(t *testing.T) {
	bridge := NewBridge(48000)
	source := sourceBinding{rate: 48000, frames: 48000, hash: [8]uint32{1}}
	bridge.bindSource(source)
	params := dsp.DefaultParams()
	vector := scheduleMoveVector{0, 2, 0, 0, 0, 0, 48000, 3}
	if !bridge.beginSchedule(source, 1, 1, params) {
		t.Fatal("begin rejected")
	}
	if allocations := testing.AllocsPerRun(100, func() {
		if !vector.stage(bridge, 0) {
			t.Fatal("stage rejected")
		}
	}); allocations != 0 {
		t.Fatal("numeric staging allocated", allocations)
	}
	revision := uint64(1)
	if allocations := testing.AllocsPerRun(100, func() {
		revision++
		if !bridge.beginSchedule(source, revision, 1, params) || !vector.stage(bridge, 0) || !bridge.commitSchedule() {
			t.Fatal("publication rejected")
		}
	}); allocations != 0 {
		t.Fatal("complete revision publication allocated", allocations)
	}
	if !bridge.setScheduleLooping(true) || !bridge.setScheduleLooping(false) {
		t.Fatal("loop mode rejected while attached")
	}
	var left, right, outL, outR [128]float32
	if allocations := testing.AllocsPerRun(100, func() {
		if !bridge.ProcessBlock(left[:], right[:], outL[:], outR[:]) {
			t.Fatal("processing rejected")
		}
	}); allocations != 0 {
		t.Fatal("bridge processing allocated", allocations)
	}
}

func TestOneMovePerQuantumStagingKeepsOldRevisionUntilCommit(t *testing.T) {
	source, params, schedule := scheduleFixture(t, 48000)
	active, control := NewBridge(48000), NewBridge(48000)
	active.bindSource(source)
	control.bindSource(source)
	install(t, active, source, params, schedule, 1)
	install(t, control, source, params, schedule, 1)
	if !active.beginSchedule(source, 2, 128, params) {
		t.Fatal("begin rejected")
	}
	var left, right, actualL, actualR, expectedL, expectedR [128]float32
	for moveIndex := range 128 {
		start := int64(moveIndex) * 300
		points := []automation.Point{{Frame: start, Value: -.5}, {Frame: start + 200, Value: -.5}}
		if !active.stageScheduleMove(moveIndex, automation.InputGain, 0, false, points) {
			t.Fatal("stage rejected")
		}
		for i := range left {
			left[i] = float32((moveIndex*128+i)*73%997-498) / 1024
			right[i] = float32((moveIndex*128+i)*31%991-495) / 1024
		}
		active.ProcessBlock(left[:], right[:], actualL[:], actualR[:])
		control.ProcessBlock(left[:], right[:], expectedL[:], expectedR[:])
		if actualL != expectedL || actualR != expectedR || active.scheduleRevision() != 1 {
			t.Fatal("staging changed active PCM or revision")
		}
	}
	if !control.beginSchedule(source, 2, 128, params) {
		t.Fatal("control begin failed")
	}
	for i := range 128 {
		start := int64(i) * 300
		control.stageScheduleMove(i, automation.InputGain, 0, false, []automation.Point{{Frame: start, Value: -.5}, {Frame: start + 200, Value: -.5}})
	}
	if !active.commitSchedule() || !control.commitSchedule() {
		t.Fatal("commit failed")
	}
	for range 4 {
		active.ProcessBlock(left[:], right[:], actualL[:], actualR[:])
		control.ProcessBlock(left[:], right[:], expectedL[:], expectedR[:])
		if actualL != expectedL || actualR != expectedR {
			t.Fatal("atomic commit lost the ongoing source phase")
		}
	}
}
