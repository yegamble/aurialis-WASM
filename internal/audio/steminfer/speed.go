package steminfer

// cspell:words steminfer

import "math"

// Backend names this build's matrix kernel: "apple-accelerate" (macOS with
// cgo) or "portable-go" (everything else).
func Backend() string { return matrixBackendName() }

// Accelerated reports whether inference uses Apple Accelerate. Only that
// backend has finished a window in a usable time.
func Accelerated() bool { return matrixBackendName() == "apple-accelerate" }

// Speed is the model's window geometry and the recorded time per window for
// this build's backend.
type Speed struct {
	// WindowSeconds is one model window; HopSeconds is the step between windows.
	WindowSeconds float64
	HopSeconds    float64
	// IdleSecondsPerWindow and BusySecondsPerWindow are the measurements in
	// docs/tasks.md ("Smart Split with a trained model"): 32 s on an idle
	// 8-core M2 MacBook Air with Accelerate, and 2 min 53 s on the same Mac
	// under heavy load. They are recorded figures, not a calibration of the
	// computer running the server.
	IdleSecondsPerWindow float64
	BusySecondsPerWindow float64
}

const windowSeconds = float64(maximumWindowSamples) / modelSampleRate

// RecordedSpeed returns the window geometry and, on accelerated builds, the
// recorded per-window times. ok is false on the plain-Go backend, which did
// not finish one window in 30 minutes, so no estimate is offered.
func RecordedSpeed() (speed Speed, ok bool) {
	speed = Speed{WindowSeconds: windowSeconds, HopSeconds: windowSeconds / 2}
	if !Accelerated() {
		return speed, false
	}
	speed.IdleSecondsPerWindow, speed.BusySecondsPerWindow = 32, 173
	return speed, true
}

// Windows is the number of model windows a song of this length needs. It
// follows the chunk assembler: songs longer than one window are padded by
// half a window at each end, and windows advance by half a window.
func Windows(seconds float64) int {
	if !(seconds > 0) {
		return 0
	}
	frames := int(math.Min(seconds, 1e6) * modelSampleRate)
	chunk, step := maximumWindowSamples, maximumWindowSamples/2
	total := frames
	if frames > chunk {
		total += chunk
	}
	return (total + step - 1) / step
}
