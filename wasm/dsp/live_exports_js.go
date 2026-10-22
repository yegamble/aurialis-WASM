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

// WasmLiveReset resets the same engine used by the existing JSON control API.
//
//go:wasmexport aurialis_live_reset
func WasmLiveReset() uint32 {
	return liveBlocks.reset()
}

func runtimeBridge() *Bridge          { return globalBridge }
func runtimeBlocks() *liveBlockBridge { return &liveBlocks }
