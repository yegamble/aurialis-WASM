//go:build js && wasm

package main

// cspell:words wasmexport

// Addresses refer to fixed Go-owned linear-memory buffers. JS typed-array views
// must be rebuilt whenever exports.mem.buffer changes after a Go call.
var liveBlocks = liveBlockBridge{bridge: globalBridge}

// WasmLiveBuffer exposes one fixed channel through the WebAssembly export table.
//
//go:wasmexport aurialis_live_buffer
func WasmLiveBuffer(channel uint32) *[liveBlockFrames]float32 {
	return liveBlocks.buffer(channel)
}

// WasmLiveProcess processes the fixed 128-frame channels through the shared engine.
//
//go:wasmexport aurialis_live_process
func WasmLiveProcess() uint32 {
	return liveBlocks.process()
}

// WasmLiveEndInput marks the source's last input frame at offset (0–128) in
// the next block. That block drains the lookahead tail an export render would
// (aurialis_live_tail_buffer, aurialis_live_tail_frames) without stopping the
// engine. It returns 1, or 0 for an invalid offset or a second mark before
// reset or aurialis_live_resume_input.
//
//go:wasmexport aurialis_live_end_input
func WasmLiveEndInput(offset uint32) uint32 {
	return liveBlocks.endInput(offset)
}

// WasmLiveTailBuffer exposes one channel of the lookahead tail drained at
// the source's end (0 left, 1 right; 512 frames).
//
//go:wasmexport aurialis_live_tail_buffer
func WasmLiveTailBuffer(channel uint32) *[liveTailFrames]float32 {
	return liveBlocks.tailBuffer(channel)
}

// WasmLiveTailFrames reports the drained tail's length, or 0 before a source end.
//
//go:wasmexport aurialis_live_tail_frames
func WasmLiveTailFrames() uint32 {
	return liveBlocks.tailFrames()
}

// WasmLiveResumeInput cancels a source-end mark (Repeat turned back on). The
// engine kept processing the input, so its output simply plays on.
//
//go:wasmexport aurialis_live_resume_input
func WasmLiveResumeInput() uint32 {
	return liveBlocks.resumeInput()
}

// WasmLiveReset resets the same engine used by the existing JSON control API.
//
//go:wasmexport aurialis_live_reset
func WasmLiveReset() uint32 {
	return liveBlocks.reset()
}

func runtimeBridge() *Bridge          { return globalBridge }
func runtimeBlocks() *liveBlockBridge { return &liveBlocks }
