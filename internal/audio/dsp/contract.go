package dsp

// LegacyAlgorithmVersion identifies the original, unchanged DSP behavior.
// A wire/control ABI version is separate from this sonic algorithm version.
const LegacyAlgorithmVersion uint32 = 1

// TruePeakAlgorithmVersion is v1 with a lookahead limiter that bounds the
// 4x reconstructed (BS.1770-style) peak instead of estimating it. It buffers
// LatencyFrames of audio, so callers must compensate and Drain the tail.
const TruePeakAlgorithmVersion uint32 = 2

func supportsAlgorithm(version uint32) bool {
	return version == 0 || version == LegacyAlgorithmVersion || version == TruePeakAlgorithmVersion
}

func algorithmOf(p Params) uint32 {
	if p.AlgorithmVersion == TruePeakAlgorithmVersion {
		return TruePeakAlgorithmVersion
	}
	return LegacyAlgorithmVersion
}

// AlgorithmVersion returns the effective algorithm; omitted/zero settings retain
// v1. New algorithms must be implemented and verified before they are accepted.
func (e *Engine) AlgorithmVersion() uint32 { return algorithmOf(e.params) }

// LatencyFrames reports buffered audio frames, excluding filter phase response
// and any transport delay. The immediate v1 engine buffers no frames; v2 buffers
// its true-peak lookahead at every setting, including bypass.
func (e *Engine) LatencyFrames() int {
	if e.AlgorithmVersion() == TruePeakAlgorithmVersion {
		return e.truePeak.latency
	}
	return 0
}

// Drain emits buffered audio after the last input frame, up to the shorter
// output slice. It does not extend a source with an IIR decay or reset history.
// The immediate v1 engine has no buffered frames; outputs remain untouched.
// For v2 it flushes the lookahead with silence and returns the frames written.
func (e *Engine) Drain(outL, outR []float32) int {
	if e.AlgorithmVersion() != TruePeakAlgorithmVersion {
		return 0
	}
	n := min(len(outL), len(outR), e.truePeak.pending)
	passthrough := e.params.Bypass || (e.isChainNeutral() && !e.params.ABOriginal)
	for i := 0; i < n; i++ {
		if passthrough {
			outL[i], outR[i] = e.truePeakPassthrough(0, 0)
			continue
		}
		l, r, rawL, rawR := e.processTruePeakStage(0, 0, 0, 0, e.params.Limiter.Enabled)
		outL[i], outR[i] = e.finishSample(l, r, rawL, rawR, e.params.Limiter.Enabled)
	}
	e.truePeak.pending -= n
	return n
}

// RenderLatencyCompensated runs process over the whole input into buffers
// sized for the engine's latency, drains the tail, and returns output aligned
// with the input. process must write len(inL) frames starting at index 0.
func RenderLatencyCompensated(e *Engine, frames int, process func(outL, outR []float32) error) ([]float32, []float32, error) {
	latency := e.LatencyFrames()
	outL, outR := make([]float32, frames+latency), make([]float32, frames+latency)
	if err := process(outL[:frames], outR[:frames]); err != nil {
		return nil, nil, err
	}
	e.Drain(outL[frames:], outR[frames:])
	return outL[latency:], outR[latency:], nil
}
