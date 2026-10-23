package dsp

import (
	"errors"
	"math"
)

const studioLimiterHighCapacity = 2048

// This private gain planner consumes and returns actual 4x audio samples. It is
// not a final limiter: decimation and final-output reconstruction can add peaks.
// Each incoming peak plans a linear 2 ms attack over buffered, unreturned audio;
// transient and sustained release states can only lower that planned gain.
type studioLimiterGain4x struct {
	audio                                                     [2][studioLimiterHighCapacity]float64
	envelope                                                  studioGainEnvelope
	frame                                                     int64
	lookahead                                                 int
	enabled                                                   bool
	ceiling, safety                                           float64
	fastGain, slowGain, exposure, lastGain                    float64
	fastRelease, slowRelease, exposureAttack, exposureRelease float64
}

func prepareStudioLimiterGain4x(rate float64, params LimiterParams) (studioLimiterGain4x, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 {
		return studioLimiterGain4x{}, errors.New("invalid studio 4x limiter sample rate")
	}
	base := DefaultParams()
	base.Limiter = params
	if err := ValidateParams(base); err != nil {
		return studioLimiterGain4x{}, err
	}
	highRate := rate * 4
	l := studioLimiterGain4x{
		lookahead:       4 * int(math.Ceil(rate*.002)),
		enabled:         params.Enabled,
		ceiling:         dbToLin(params.CeilingDBTP),
		safety:          dbToLin(-.02),
		fastRelease:     studioPole(highRate, math.Max(5, params.ReleaseMS*.25)),
		slowRelease:     studioPole(highRate, params.ReleaseMS),
		exposureAttack:  studioPole(highRate, 50),
		exposureRelease: studioPole(highRate, 250),
	}
	l.resetHistory()
	return l, nil
}

func (l *studioLimiterGain4x) resetHistory() {
	l.audio = [2][studioLimiterHighCapacity]float64{}
	l.envelope = studioGainEnvelope{}
	l.frame = 0
	l.fastGain, l.slowGain, l.exposure, l.lastGain = 1, 1, 0, 1
}

// The last pair exposes delayed unprocessed high-rate audio for clock and gain
// diagnostics. The enabled candidate uses the full filtered audio path; its final
// downsampled output still needs independent reconstruction acceptance.
func (l *studioLimiterGain4x) process(left, right float64) (float64, float64, float64, float64) {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	slot := int(l.frame) & (studioLimiterHighCapacity - 1)
	l.audio[0][slot], l.audio[1][slot] = left, right
	peak := math.Max(math.Abs(left), math.Abs(right))
	if l.enabled && peak > l.ceiling {
		required := l.ceiling * l.safety / peak
		l.envelope.add(l.frame, 0, l.lookahead, 0, required)
	}
	source := l.frame - int64(l.lookahead)
	bound := l.envelope.bound(l.frame)
	l.frame++
	if l.enabled {
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
		return 0, 0, 0, 0
	}
	index := int(source) & (studioLimiterHighCapacity - 1)
	dryLeft, dryRight := l.audio[0][index], l.audio[1][index]
	if l.lastGain == 1 {
		return dryLeft, dryRight, dryLeft, dryRight
	}
	return dryLeft * l.lastGain, dryRight * l.lastGain, dryLeft, dryRight
}
