// cspell:ignore Upsampler Downsampler

package dsp

import "errors"

// This distinct candidate has the audible FIR's measured response and delay.
// It is private: no Engine factory or capability selects it. Limiting and final
// record truncation can introduce new high frequencies after that FIR, so its
// response alone cannot establish a final-output reconstruction ceiling.
type studioAudibleLimiterPath struct {
	kernel *studioAudibleKernel
	up     studioAudibleUpsampler
	down   studioAudibleDownsampler
}

func prepareStudioAudibleGraph(rate float64, params Params, frames int64, repeat bool) (*studioGraph, error) {
	if params.Repair.Enabled && params.Repair.DeClip {
		return nil, errors.New("private audible graph requires separately prepared clipping repair")
	}
	g, err := prepareStudioGraph(rate, params, frames, repeat)
	if err != nil {
		return nil, err
	}
	// The gain planner's lookahead and release clock are explicitly 4x. A 2x
	// filter comparison does not authorize changing those temporal semantics.
	kernel, err := prepareStudioAudibleKernel(rate, 4)
	if err != nil {
		return nil, err
	}
	g.audible = &studioAudibleLimiterPath{kernel: kernel}
	g.coreLatency = kernel.pairLatency + g.gain.lookahead/4
	g.preGuardLatency = studioSaturationLatency + g.coreLatency
	g.latency = g.preGuardLatency + g.guard.latency
	if g.coreLatency >= len(g.limiterDry[0]) || g.latency >= studioGraphDelayCapacity {
		return nil, errors.New("private audible graph exceeds fixed delay capacity")
	}
	return g, nil
}

func (p *studioAudibleLimiterPath) resetHistory() {
	p.up, p.down = studioAudibleUpsampler{}, studioAudibleDownsampler{}
}

func (p *studioAudibleLimiterPath) process(gain *studioLimiterGain4x, left, right float64) (float64, float64) {
	subs := p.up.process(p.kernel, left, right)
	for phase, pair := range subs {
		a, b, _, _ := gain.process(pair[0], pair[1])
		subs[phase] = [2]float64{a, b}
	}
	return p.down.process(p.kernel, subs)
}
