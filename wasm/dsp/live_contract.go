package main

import (
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"math"
)

// ABI 1 remains exactly 81 values and always renders algorithm 1. ABI 2
// appends an explicit sonic algorithm version: 1, or 2 (the export path's
// lookahead true-peak limiter, which the host must latency-compensate).
const liveVersionedControlValues = liveControlValues + 1

type liveVersionedControlVector [liveVersionedControlValues]float64

func liveControlCount(abi uint32) uint32 {
	switch abi {
	case 1:
		return liveControlValues
	case 2:
		return liveVersionedControlValues
	default:
		return 0
	}
}

func liveAlgorithmSupported(version uint32) uint32 {
	if liveAlgorithm(float64(version)) {
		return 1
	}
	return 0
}

func liveAlgorithm(value float64) bool {
	return value == float64(dsp.LegacyAlgorithmVersion) || value == float64(dsp.TruePeakAlgorithmVersion) || value == float64(dsp.OversampledAlgorithmVersion)
}

func (v *liveVersionedControlVector) apply(bridge *Bridge, count uint32) uint32 {
	if bridge == nil || count != liveVersionedControlValues || !liveAlgorithm(v[liveControlValues]) {
		return 0
	}
	var legacy liveControlVector
	copy(legacy[:], v[:liveControlValues])
	params, accepted := legacy.params()
	if !accepted {
		return 0
	}
	params.AlgorithmVersion = uint32(v[liveControlValues])
	if !bridge.SetParams(params) {
		return 0
	}
	return 1
}

// An invalid implementation count must fail the host's capability check, never
// wrap around to zero latency or a plausible short tail.
func liveFrameCount(frames int) uint32 {
	if frames < 0 || frames > math.MaxInt32 {
		return math.MaxUint32
	}
	return uint32(frames)
}
