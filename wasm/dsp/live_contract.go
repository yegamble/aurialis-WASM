package main

import (
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"math"
)

// ABI 1 remains exactly 81 values. ABI 2 appends an explicit sonic algorithm
// version; it does not imply that algorithm 2 exists.
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
	if version == dsp.LegacyAlgorithmVersion {
		return 1
	}
	return 0
}

func (v *liveVersionedControlVector) apply(bridge *Bridge, count uint32) uint32 {
	if bridge == nil || count != liveVersionedControlValues || v[liveControlValues] != float64(dsp.LegacyAlgorithmVersion) {
		return 0
	}
	var legacy liveControlVector
	copy(legacy[:], v[:liveControlValues])
	params, accepted := legacy.params()
	if !accepted {
		return 0
	}
	params.AlgorithmVersion = dsp.LegacyAlgorithmVersion
	bridge.SetParams(params)
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
