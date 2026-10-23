package dsp

import (
	"errors"
	"math"
)

const studioPostGuardLimiterCapacity = 4096

type studioPostGuardLimiterPeak struct {
	frame                int64
	value, raw, required float64
}

// This private reconstruction guard is an empirical candidate, not a ceiling
// certificate for arbitrary ideal-sinc finite records. Its detector follows the
// actual 4x gain/downsampling path. FIR availability and reconstruction support
// add measured delay beyond the nominal 2 ms attack. Disabled output keeps it.
type studioPostGuardLimiter struct {
	rate                                                      float64
	params                                                    LimiterParams
	kernel                                                    studioPostGuardKernel
	detector                                                  studioPostGuardDetector
	audio                                                     [2][studioPostGuardLimiterCapacity]float64
	peaks                                                     [studioPostGuardLimiterCapacity]studioPostGuardLimiterPeak
	envelope                                                  studioGainEnvelope
	frame                                                     int64
	lookahead, latency                                        int
	ceiling, safety                                           float64
	fastGain, slowGain, exposure, lastGain                    float64
	fastRelease, slowRelease, exposureAttack, exposureRelease float64
}

func prepareStudioPostGuardLimiter(rate float64, params LimiterParams) (studioPostGuardLimiter, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 {
		return studioPostGuardLimiter{}, errors.New("invalid studio limiter sample rate")
	}
	base := DefaultParams()
	base.Limiter = params
	if err := ValidateParams(base); err != nil {
		return studioPostGuardLimiter{}, err
	}
	lookahead := int(math.Ceil(rate * .002))
	l := studioPostGuardLimiter{rate: rate, params: params, kernel: prepareStudioPostGuardKernel(), lookahead: lookahead, latency: lookahead + 2*studioPostGuardAvailability, ceiling: dbToLin(params.CeilingDBTP), safety: dbToLin(-.02), fastGain: 1, slowGain: 1, lastGain: 1}
	l.prepareRelease()
	return l, nil
}

func (l *studioPostGuardLimiter) prepareRelease() {
	l.fastRelease = studioPole(l.rate, math.Max(5, l.params.ReleaseMS*.25))
	l.slowRelease = studioPole(l.rate, l.params.ReleaseMS)
	l.exposureAttack, l.exposureRelease = studioPole(l.rate, 50), studioPole(l.rate, 250)
}

func (l *studioPostGuardLimiter) requiredGain(peak, raw float64) float64 {
	if !l.params.TruePeak {
		peak = raw
	}
	if peak <= l.ceiling {
		return 1
	}
	return l.ceiling * l.safety / peak
}

func (l *studioPostGuardLimiter) setParams(params LimiterParams) error {
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
	l.rebuildEnvelope()
	if !params.Enabled {
		l.fastGain, l.slowGain, l.exposure, l.lastGain = 1, 1, 0, 1
	}
	return nil
}

func (l *studioPostGuardLimiter) resetHistory() {
	l.audio = [2][studioPostGuardLimiterCapacity]float64{}
	l.peaks = [studioPostGuardLimiterCapacity]studioPostGuardLimiterPeak{}
	l.detector = studioPostGuardDetector{}
	l.envelope.resetHistory()
	l.frame = 0
	l.fastGain, l.slowGain, l.exposure, l.lastGain = 1, 1, 0, 1
}

func (l *studioPostGuardLimiter) envelopeTiming() (int, int) {
	if l.params.TruePeak {
		return 0, 2 * studioPostGuardAvailability
	}
	return studioPostGuardAvailability, 0
}
func (l *studioPostGuardLimiter) rebuildEnvelope() {
	l.envelope.resetHistory()
	delay, hold := l.envelopeTiming()
	for _, peak := range l.peaks {
		birth := peak.frame + int64(studioPostGuardAvailability+delay)
		l.envelope.addActive(l.frame, birth, l.lookahead, hold, peak.required)
	}
}

func (l *studioPostGuardLimiter) process(left, right float64) (float64, float64) {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	index := l.frame & (studioPostGuardLimiterCapacity - 1)
	l.audio[0][index], l.audio[1][index] = left, right
	frame, peak := l.detector.process(&l.kernel, left, right)
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
