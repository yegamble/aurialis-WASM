package dsp

// LegacyAlgorithmVersion identifies the original, unchanged DSP behavior.
// A wire/control ABI version is separate from this sonic algorithm version.
const LegacyAlgorithmVersion uint32 = 1

func supportsAlgorithm(version uint32) bool {
	return version == 0 || version == LegacyAlgorithmVersion
}

// AlgorithmVersion returns the effective algorithm; omitted/zero settings retain
// v1. New algorithms must be implemented and verified before they are accepted.
func (e *Engine) AlgorithmVersion() uint32 { return LegacyAlgorithmVersion }

// LatencyFrames reports buffered audio frames, excluding filter phase response
// and any transport delay. The current immediate v1 engine buffers no frames.
func (e *Engine) LatencyFrames() int { return 0 }

// Drain emits buffered audio after the last input frame, up to the shorter
// output slice. It does not extend a source with an IIR decay or reset history.
// The immediate v1 engine has no buffered frames; outputs remain untouched.
func (e *Engine) Drain(_, _ []float32) int { return 0 }
