//go:build wasm

package main

import "github.com/yegamble/Aurialis-WASM/internal/audio/automation"

// cspell:words wasmexport

var scheduleSource scheduleSourceVector
var scheduleMove scheduleMoveVector

// WasmScheduleABIVersion advertises the independently versioned compiled-schedule ABI.
//
//go:wasmexport aurialis_schedule_abi
func WasmScheduleABIVersion() uint32 { return 1 }

// WasmScheduleSourceBuffer exposes version/rate/frames plus eight big-endian SHA-256 words.
//
//go:wasmexport aurialis_schedule_source_buffer
func WasmScheduleSourceBuffer() *[scheduleSourceValues]float64 {
	return (*[scheduleSourceValues]float64)(&scheduleSource)
}

// WasmScheduleBindSource binds authoritative import metadata before attaching automation.
//
//go:wasmexport aurialis_schedule_bind_source
func WasmScheduleBindSource() uint32 {
	source, ok := scheduleSource.binding()
	if ok && runtimeBridge().bindSource(source) {
		return 1
	}
	return 0
}

// WasmScheduleBegin stages a complete baseline and source-bound revision without activating it.
//
//go:wasmexport aurialis_schedule_begin
func WasmScheduleBegin(revision float64, count uint32, deviceRate uint32) uint32 {
	if !integer(revision, 1, 1<<53-1) || count > 128 || float64(deviceRate) != runtimeBridge().SampleRate() {
		return 0
	}
	source, ok := scheduleSource.binding()
	if !ok || versionedControls[liveControlValues] != 1 {
		return 0
	}
	var legacy liveControlVector
	copy(legacy[:], versionedControls[:liveControlValues])
	baseline, ok := legacy.params()
	if !ok {
		return 0
	}
	baseline.AlgorithmVersion = 1
	if runtimeBridge().beginSchedule(source, uint64(revision), int(count), baseline) {
		return 1
	}
	return 0
}

// WasmScheduleMoveBuffer exposes target/count/fade/muted then at most 256 frame/value pairs.
//
//go:wasmexport aurialis_schedule_move_buffer
func WasmScheduleMoveBuffer() *[scheduleMoveValues]float64 {
	return (*[scheduleMoveValues]float64)(&scheduleMove)
}

// WasmScheduleStageMove validates/copies only one bounded move into the inactive slot.
//
//go:wasmexport aurialis_schedule_stage_move
func WasmScheduleStageMove(index uint32) uint32 {
	if scheduleMove.stage(runtimeBridge(), index) {
		return 1
	}
	return 0
}

// WasmScheduleCommit atomically publishes the staged baseline/revision and preserves source phase.
//
//go:wasmexport aurialis_schedule_commit
func WasmScheduleCommit() uint32 {
	if runtimeBridge().commitSchedule() {
		return 1
	}
	return 0
}

// WasmScheduleRevision acknowledges the latest accepted revision, exactly representable in JS.
//
//go:wasmexport aurialis_schedule_revision
func WasmScheduleRevision() float64 { return float64(runtimeBridge().scheduleRevision()) }

// WasmScheduleSeek reconstructs source-zero envelopes and resets DSP history at an exact source frame.
//
//go:wasmexport aurialis_schedule_seek
func WasmScheduleSeek(sourceFrame float64) uint32 {
	if integer(sourceFrame, 0, automation.MaxSourceFrames) && runtimeBridge().seekSchedule(int64(sourceFrame)) {
		return 1
	}
	return 0
}

// WasmScheduleDetach restores the explicit static baseline and permits ordinary static edits.
//
//go:wasmexport aurialis_schedule_detach
func WasmScheduleDetach() uint32 {
	if runtimeBridge().detachSchedule() {
		return 1
	}
	return 0
}

// WasmScheduleSetLooping follows source wrapping with exact rational phase and continuous DSP history.
//
//go:wasmexport aurialis_schedule_set_looping
func WasmScheduleSetLooping(enabled uint32) uint32 {
	if enabled > 1 {
		return 0
	}
	if runtimeBridge().setScheduleLooping(enabled == 1) {
		return 1
	}
	return 0
}
