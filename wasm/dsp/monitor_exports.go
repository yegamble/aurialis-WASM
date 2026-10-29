//go:build wasip1 && wasm

package main

// cspell:words wasmexport

var auditionMonitor liveMonitor

// WasmSetMonitorMode selects stereo (0), mono (1), or side (2), with a 10 ms
// linear matrix fade. It is independent of both parameter packet ABIs.
//
//go:wasmexport aurialis_set_monitor_mode
func WasmSetMonitorMode(mode uint32) uint32 {
	return auditionMonitor.setMode(mode, runtimeBridge().SampleRate())
}

// WasmMonitorBuffer exposes a final-stage 128-frame channel. The host supplies
// aligned pre-match meter PCM in 0/1 and audible A/B PCM in 2/3 before processing.
//
//go:wasmexport aurialis_monitor_buffer
func WasmMonitorBuffer(channel uint32) *[liveBlockFrames]float32 {
	return auditionMonitor.buffer(channel)
}

// WasmMonitorProcess transforms both pairs with identical frame coefficients.
// Returns 128, or zero on invalid input without advancing the fade.
//
//go:wasmexport aurialis_monitor_process
func WasmMonitorProcess() uint32 { return auditionMonitor.process() }
