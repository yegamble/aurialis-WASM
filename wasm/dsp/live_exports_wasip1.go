//go:build wasip1 && wasm

package main

// cspell:words wasmexport wasip1

// A WASI reactor is initialized by its host through _initialize. It then owns
// one shared engine and fixed control/channel buffers for this module instance.
// Browser hosts must provide no filesystem, network, timer or blocking capability.
var reactorBridge = NewBridge(48000)
var reactorBlocks = liveBlockBridge{bridge: reactorBridge}
var reactorControls liveControlVector

// WasmInit constructs the shared DSP state before playback begins.
//
//go:wasmexport aurialis_init
func WasmInit(sampleRate float64) uint32 {
	if !validLiveSampleRate(sampleRate) {
		return 0
	}
	reactorBridge.Init(sampleRate)
	return 1
}

// WasmLiveBuffer exposes one fixed 128-frame linear-memory channel.
//
//go:wasmexport aurialis_live_buffer
func WasmLiveBuffer(channel uint32) *[liveBlockFrames]float32 {
	return reactorBlocks.buffer(channel)
}

// WasmLiveProcess processes one bounded stereo quantum with the shared Go DSP.
//
//go:wasmexport aurialis_live_process
func WasmLiveProcess() uint32 {
	return reactorBlocks.process()
}

// WasmLiveEndInput marks the source's last input frame at offset (0–128) in
// the next block. That block drains the lookahead tail an export render would
// (aurialis_live_tail_buffer, aurialis_live_tail_frames) without stopping the
// engine. It returns 1, or 0 for an invalid offset or a second mark before
// reset or aurialis_live_resume_input.
//
//go:wasmexport aurialis_live_end_input
func WasmLiveEndInput(offset uint32) uint32 {
	return reactorBlocks.endInput(offset)
}

// WasmLiveTailBuffer exposes one channel of the lookahead tail drained at
// the source's end (0 left, 1 right; 512 frames).
//
//go:wasmexport aurialis_live_tail_buffer
func WasmLiveTailBuffer(channel uint32) *[liveTailFrames]float32 {
	return reactorBlocks.tailBuffer(channel)
}

// WasmLiveTailFrames reports the drained tail's length, or 0 before a source end.
//
//go:wasmexport aurialis_live_tail_frames
func WasmLiveTailFrames() uint32 {
	return reactorBlocks.tailFrames()
}

// WasmLiveResumeInput cancels a source-end mark (Repeat turned back on). The
// engine kept processing the input, so its output simply plays on.
//
//go:wasmexport aurialis_live_resume_input
func WasmLiveResumeInput() uint32 {
	return reactorBlocks.resumeInput()
}

// WasmLiveReset clears only DSP history while retaining the current settings.
//
//go:wasmexport aurialis_live_reset
func WasmLiveReset() uint32 {
	return reactorBlocks.reset()
}

// WasmControlBuffer exposes the complete 81-value control vector.
//
//go:wasmexport aurialis_control_buffer
func WasmControlBuffer() *[liveControlValues]float64 {
	return (*[liveControlValues]float64)(&reactorControls)
}

// WasmSetControls validates and applies the fixed vector atomically.
//
//go:wasmexport aurialis_set_controls
func WasmSetControls() uint32 {
	return reactorControls.apply(reactorBridge)
}

func runtimeBridge() *Bridge          { return reactorBridge }
func runtimeBlocks() *liveBlockBridge { return &reactorBlocks }
