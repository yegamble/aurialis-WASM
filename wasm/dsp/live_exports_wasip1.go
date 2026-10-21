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

// WasmLiveReset clears only DSP history while retaining the current settings.
//
//go:wasmexport aurialis_live_reset
func WasmLiveReset() uint32 {
	return reactorBlocks.reset()
}

// WasmControlBuffer exposes the complete 56-value control vector.
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
