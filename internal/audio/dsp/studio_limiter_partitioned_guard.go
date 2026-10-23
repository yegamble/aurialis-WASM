package dsp

import "math"

const studioPartitionedPostGuardAvailability = studioPostGuardAvailability + studioPostPartitionDelay

// This DISTINCT private path replaces only the detector convolution. Physical
// reconstruction support S=513 is unchanged; FFT block availability A=640 adds
// exactly 127 frames to buffered output. It still uses the heuristic Newton
// finite-quintic search with its preserved one-ULP seed discontinuity. Neither
// conservative quintic experiment nor a public algorithm is selected here.
// The direct guard and its preparation/state remain available as the baseline.
type studioPartitionedPostGuardPath struct {
	kernel   *studioPartitionedPostGuardKernel
	detector studioPartitionedPostGuardDetector
}

func prepareStudioPartitionedPostGuardPath(l *studioPostGuardLimiter) *studioPartitionedPostGuardPath {
	l.latency = l.lookahead + studioPartitionedPostGuardAvailability + studioPostGuardAvailability
	return &studioPartitionedPostGuardPath{kernel: prepareStudioPartitionedPostGuardKernel()}
}

func (p *studioPartitionedPostGuardPath) resetHistory() {
	p.detector = studioPartitionedPostGuardDetector{}
}

// These control changes exercise only this private guard. The graph constructor
// remains fixed-parameter; this is not a live algorithm2 automation interface.
func (p *studioPartitionedPostGuardPath) setParams(l *studioPostGuardLimiter, params LimiterParams) error {
	if params == l.params {
		return nil
	}
	base := DefaultParams()
	base.Limiter = params
	if err := ValidateParams(base); err != nil {
		return err
	}
	l.params, l.ceiling = params, dbToLin(params.CeilingDBTP)
	l.prepareRelease()
	for i := range l.peaks {
		peak := &l.peaks[i]
		peak.required = l.requiredGain(peak.value, peak.raw)
	}
	l.envelope.resetHistory()
	// Delay remains S in sample-peak mode; using A would plan 127 frames late.
	delay, hold := l.envelopeTiming()
	for _, peak := range l.peaks {
		birth := peak.frame + int64(studioPartitionedPostGuardAvailability+delay)
		l.envelope.addActive(l.frame, birth, l.lookahead, hold, peak.required)
	}
	if !params.Enabled {
		l.fastGain, l.slowGain, l.exposure, l.lastGain = 1, 1, 0, 1
	}
	return nil
}

func (p *studioPartitionedPostGuardPath) process(l *studioPostGuardLimiter, left, right float64) (float64, float64) {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	index := l.frame & (studioPostGuardLimiterCapacity - 1)
	l.audio[0][index], l.audio[1][index] = left, right
	frame, peak := p.detector.process(p.kernel, left, right)
	raw := 0.0
	if frame >= 0 {
		slot := frame & (studioPostGuardLimiterCapacity - 1)
		raw = math.Max(math.Abs(l.audio[0][slot]), math.Abs(l.audio[1][slot]))
	}
	l.peaks[frame&(studioPostGuardLimiterCapacity-1)] = studioPostGuardLimiterPeak{frame: frame, value: peak, raw: raw, required: l.requiredGain(peak, raw)}
	delay, hold := l.envelopeTiming()
	l.envelope.add(l.frame, delay, l.lookahead, hold, l.requiredGain(peak, raw))
	source := l.frame - int64(l.latency)
	bound := l.envelope.bound(l.frame)
	l.frame++
	if l.params.Enabled {
		if bound < l.fastGain {
			l.fastGain = bound
		} else {
			l.fastGain = l.fastRelease*l.fastGain + (1-l.fastRelease)*bound
		}
		if bound < l.slowGain {
			l.slowGain = bound
		} else {
			l.slowGain = l.slowRelease*l.slowGain + (1-l.slowRelease)*bound
		}
		target := math.Min(1, (1-bound)/.75)
		pole := l.exposureRelease
		if target > l.exposure {
			pole = l.exposureAttack
		}
		l.exposure = pole*l.exposure + (1-pole)*target
		l.lastGain = math.Min(bound, math.Min(l.fastGain, 1-l.exposure*(1-l.slowGain)))
	} else {
		l.lastGain = 1
	}
	if source < 0 {
		return 0, 0
	}
	slot := source & (studioPostGuardLimiterCapacity - 1)
	if l.lastGain == 1 {
		return l.audio[0][slot], l.audio[1][slot]
	}
	return sanitizeSample(l.audio[0][slot] * l.lastGain), sanitizeSample(l.audio[1][slot] * l.lastGain)
}
