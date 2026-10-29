package steminfer

// cspell:words steminfer

import "math"

// Backend names this build's matrix kernel: "apple-accelerate" (macOS with
// cgo), "packed-avx2-fma" (qualified Linux/Windows amd64), "gonum-sse3",
// or "portable-go".
// SSE3 and scalar fallbacks have not passed the usable-time qualification.
func Backend() string { return matrixBackendName() }

// Accelerated reports a hardware backend that passed its model qualification.
// Only AVX2/FMA is qualified on Linux/Windows; the SSE3 fallback stays disabled.
func Accelerated() bool {
	backend := matrixBackendName()
	return backend == "apple-accelerate" || backend == "packed-avx2-fma"
}

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
	// computer running the server, and only Apple silicon (arm64) was timed:
	// a darwin/amd64 cgo build also uses Accelerate but has no measurement,
	// so /api/stems/model reports the arch and the client caveats it.
	IdleSecondsPerWindow float64
	BusySecondsPerWindow float64
}

const windowSeconds = float64(maximumWindowSamples) / modelSampleRate

// RecordedSpeed returns geometry and the recorded Apple timing figures.
// Qualified packed SIMD is available without publishing Apple timings as its
// estimate. Its hosted Linux/Windows qualification is not a device calibration.
func RecordedSpeed() (speed Speed, ok bool) {
	speed = Speed{WindowSeconds: windowSeconds, HopSeconds: windowSeconds / 2}
	if matrixBackendName() != "apple-accelerate" {
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
