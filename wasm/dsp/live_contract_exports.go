//go:build wasm

package main

// cspell:words wasmexport

var versionedControls liveVersionedControlVector

// WasmControlCount negotiates a packet ABI independently of the sonic algorithm.
// Unknown ABIs return zero. ABI 1 has 81 values; ABI 2 has 82 values.
//
//go:wasmexport aurialis_control_count
func WasmControlCount(abi uint32) uint32 { return liveControlCount(abi) }

// WasmAlgorithmSupported advertises only implemented, explicit algorithm IDs.
//
//go:wasmexport aurialis_algorithm_supported
func WasmAlgorithmSupported(version uint32) uint32 { return liveAlgorithmSupported(version) }

// WasmLatencyFrames reports buffered DSP frames, excluding transport alignment.
//
//go:wasmexport aurialis_latency_frames
func WasmLatencyFrames() uint32 { return liveFrameCount(runtimeBridge().LatencyFrames()) }

// WasmVersionedControlBuffer exposes ABI 2 without changing the legacy buffer.
//
//go:wasmexport aurialis_control_buffer_v2
func WasmVersionedControlBuffer() *[liveVersionedControlValues]float64 {
	return (*[liveVersionedControlValues]float64)(&versionedControls)
}

// WasmSetVersionedControls rejects wrong lengths and unknown algorithms before
// changing either parameters or signal history. ABI 2 requires algorithm ID 1.
//
//go:wasmexport aurialis_set_controls_v2
func WasmSetVersionedControls(count uint32) uint32 {
	return versionedControls.apply(runtimeBridge(), count)
}

// WasmMeterBuffer exposes the fixed live meter snapshot (see liveMeterValues).
//
//go:wasmexport aurialis_meter_buffer
func WasmMeterBuffer() *[liveMeterValues]float64 { return &runtimeBlocks().meterOut }

// WasmMeterSnapshot refreshes the meter buffer from the processed output and
// returns the number of values written, or zero before initialization.
//
//go:wasmexport aurialis_meter_snapshot
func WasmMeterSnapshot() uint32 { return runtimeBlocks().meterSnapshot() }
