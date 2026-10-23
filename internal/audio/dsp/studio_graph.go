// cspell:ignore Upsampler Downsampler

package dsp

import (
	"errors"
	"math"
)

const studioGraphDelayCapacity = 4096

// This fixed-parameter candidate is private and never selected by Engine. Its
// reconstruction guard still has a known finite-Nyquist counterexample. Public
// algorithm2 remains rejected; this graph is not a final-output safety claim.
type studioGraph struct {
	params                                                     Params
	rate                                                       float64
	frames, origin, elapsed                                    int64
	repeat, draining                                           bool
	remaining                                                  int
	latency, preGuardLatency, coreLatency                      int
	front                                                      *Engine
	compressor                                                 studioCompressor
	saturation                                                 studioSaturation
	stereo                                                     studioStereo
	kernel                                                     studioLimiterAudioKernel
	up                                                         studioLimiterUpsampler
	down                                                       studioLimiterDownsampler
	gain                                                       studioLimiterGain4x
	guard                                                      studioPostGuardLimiter
	original                                                   [2][studioGraphDelayCapacity]float32
	saturationDry                                              [2][128]float64
	limiterDry                                                 [2][1024]float64
	inputGain                                                  float64
	prefixActive, compressorActive, saturationActive, identity bool
}

// frames and resetAt offsets are PCM coordinates at the processing rate. A
// differently rated live source requires a separate rational source/device EOF
// adapter; original AudioBuffer source-grid counts cannot be passed directly.
func prepareStudioGraph(rate float64, params Params, frames int64, repeat bool) (*studioGraph, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 || frames < 1 || frames > 16*1024*1024 {
		return nil, errors.New("invalid private studio graph layout")
	}
	if err := ValidateParams(params); err != nil {
		return nil, err
	}
	if params.LoudnessMatchAB {
		return nil, errors.New("automatic level matching is unsupported by the private studio graph")
	}
	cp := params.Compressor
	// Ratio1 has no compression curve. Inactive stages keep requested parameters
	// but can prepare a neutral model without migrating an active legacy setting.
	if !cp.Enabled || cp.Ratio == 1 {
		if cp.Topology == CompOptical {
			cp.KneeDB = math.Max(6, cp.KneeDB)
		}
		if cp.Topology == CompFET {
			cp.KneeDB = math.Min(6, cp.KneeDB)
		}
	}
	compressor, err := prepareStudioCompressor(rate, cp)
	if err != nil {
		return nil, err
	}
	sp := params.Saturation
	if !sp.Enabled || sp.Amount == 0 {
		sp.Character = SatClean
	}
	saturation, err := prepareStudioSaturation(rate, sp)
	if err != nil {
		return nil, err
	}
	stereo, err := prepareStudioStereo(rate, params.Stereo)
	if err != nil {
		return nil, err
	}
	lp := params.Limiter
	// Sample-peak mode uses the delayed base-rate raw-peak guard. Actual4x gain
	// processing is enabled only for the explicitly selected true-peak candidate.
	lp.Enabled = lp.Enabled && lp.TruePeak
	gain, err := prepareStudioLimiterGain4x(rate, lp)
	if err != nil {
		return nil, err
	}
	guard, err := prepareStudioPostGuardLimiter(rate, params.Limiter)
	if err != nil {
		return nil, err
	}
	g := &studioGraph{params: params, rate: rate, frames: frames, repeat: repeat, front: NewEngine(rate), compressor: compressor, saturation: saturation, stereo: stereo, kernel: prepareStudioLimiterAudioKernel(), gain: gain, guard: guard, inputGain: dbToLin(params.InputGainDB)}
	g.front.SetParams(params)
	g.coreLatency = studioLimiterResamplingLatency + gain.lookahead/4
	g.preGuardLatency = studioSaturationLatency + g.coreLatency
	g.latency = g.preGuardLatency + guard.latency
	g.compressorActive = params.Compressor.Enabled && (params.Compressor.Ratio > 1 || params.Compressor.MakeupDB != 0)
	g.saturationActive = params.Saturation.Enabled && params.Saturation.Amount > 0 && params.Saturation.Character != SatClean
	g.prefixActive = params.InputGainDB != 0 || params.DeHarsh.Enabled || params.Multiband.Enabled || (params.Repair.Enabled && (params.Repair.DeClip || params.Repair.DeEssDB != 0 || params.Repair.TransientDB != 0))
	if params.EQEnabled {
		for _, coefficient := range g.front.eqCoeffs {
			g.prefixActive = g.prefixActive || coefficient.active
		}
	}
	g.identity = !g.prefixActive && !g.compressorActive && !g.saturationActive && !params.Stereo.Enabled && !params.Limiter.Enabled && params.DitherBits == 0
	return g, nil
}

func (g *studioGraph) latencyFrames() int { return g.latency }

func (g *studioGraph) resetAt(sourceFrame int64) error {
	if sourceFrame < 0 || sourceFrame > g.frames {
		return errors.New("invalid private studio graph seek")
	}
	if g.repeat && sourceFrame == g.frames {
		sourceFrame = 0
	}
	g.origin, g.elapsed = sourceFrame, 0
	g.draining, g.remaining = false, 0
	g.front.Reset()
	g.compressor.resetHistory()
	g.saturation.resetHistory()
	g.stereo.resetHistory()
	g.gain.resetHistory()
	g.guard.resetHistory()
	g.up, g.down = studioLimiterUpsampler{}, studioLimiterDownsampler{}
	g.original = [2][studioGraphDelayCapacity]float32{}
	g.saturationDry = [2][128]float64{}
	g.limiterDry = [2][1024]float64{}
	return nil
}

func (g *studioGraph) processPrefix(left, right float64) (float64, float64) {
	e := g.front
	left, right = sanitizeSample(left)*g.inputGain, sanitizeSample(right)*g.inputGain
	if e.params.Repair.Enabled {
		left, right = e.processRepairSample(left, right)
	}
	if e.params.EQEnabled {
		for i, c := range e.eqCoeffs {
			if c.active {
				left = processSVF(c, &e.eqState[i][0], left)
				right = processSVF(c, &e.eqState[i][1], right)
			}
		}
	}
	if e.params.DeHarsh.Enabled {
		left, right = e.processDeHarsh(left, right)
	}
	if e.params.Multiband.Enabled {
		left, right = e.processMultiband(left, right)
	}
	return left, right
}

func (g *studioGraph) processFrame(left, right float32) (float32, float32) {
	if !finite(float64(left)) {
		left = 0
	}
	if !finite(float64(right)) {
		right = 0
	}
	source := g.origin + g.elapsed
	if !g.repeat && source >= g.frames {
		left, right = 0, 0
	}
	index := int(g.elapsed) & (studioGraphDelayCapacity - 1)
	g.original[0][index], g.original[1][index] = left, right
	l, r := float64(left), float64(right)
	if g.prefixActive {
		l, r = g.processPrefix(l, r)
	}
	if g.compressorActive {
		l, r = g.compressor.process(l, r)
	}
	satIndex := int(g.elapsed) & 127
	satDelayed := (satIndex - studioSaturationLatency) & 127
	dl, dr := g.saturationDry[0][satDelayed], g.saturationDry[1][satDelayed]
	g.saturationDry[0][satIndex], g.saturationDry[1][satIndex] = l, r
	if g.saturationActive {
		l, r = g.saturation.process(l, r)
	} else {
		l, r = dl, dr
	}
	l, r = g.stereo.process(l, r)
	coreIndex := int(g.elapsed) & 1023
	coreDelayed := (coreIndex - g.coreLatency) & 1023
	dl, dr = g.limiterDry[0][coreDelayed], g.limiterDry[1][coreDelayed]
	g.limiterDry[0][coreIndex], g.limiterDry[1][coreIndex] = l, r
	if g.params.Limiter.Enabled {
		subs := g.up.process(&g.kernel, l, r)
		for phase, pair := range subs {
			a, b, _, _ := g.gain.process(pair[0], pair[1])
			subs[phase] = [2]float64{a, b}
		}
		l, r = g.down.process(&g.kernel, subs)
	} else {
		l, r = dl, dr
	}
	// The final guarded record contains exactly the source interval. No discarded
	// pre-roll or post-roll is allowed to re-enter through future reconstruction.
	coreSource := source - int64(g.preGuardLatency)
	if coreSource < g.origin || (!g.repeat && coreSource >= g.frames) {
		l, r = 0, 0
	}
	l, r = g.guard.process(l, r)
	outputSource := source - int64(g.latency)
	g.elapsed++
	if outputSource < g.origin || (!g.repeat && outputSource >= g.frames) {
		return 0, 0
	}
	aligned := (index - g.latency) & (studioGraphDelayCapacity - 1)
	if g.params.Bypass || g.params.ABOriginal || g.identity {
		return g.original[0][aligned], g.original[1][aligned]
	}
	// Quantization is explicit and occurs after the candidate limiter. Its final
	// bytes require independent peak verification; no hidden ceiling clip follows.
	if g.params.DitherBits == 16 || g.params.DitherBits == 24 {
		l = g.front.applyTPDFDither(l, g.params.DitherBits)
		r = g.front.applyTPDFDither(r, g.params.DitherBits)
	}
	return finiteFloat32(l), finiteFloat32(r)
}

func (g *studioGraph) processBlock(left, right, outLeft, outRight []float32) int {
	if g.draining {
		return 0
	}
	count := min(len(left), len(right), len(outLeft), len(outRight))
	if !g.repeat {
		count = min(count, int(max(0, g.frames-g.origin-g.elapsed)))
	}
	for i := range count {
		outLeft[i], outRight[i] = g.processFrame(left[i], right[i])
	}
	return count
}

func (g *studioGraph) beginDrain() error {
	if g.repeat {
		return errors.New("continuous repeat has no finite drain boundary")
	}
	if g.origin+g.elapsed != g.frames && !g.draining {
		return errors.New("private studio graph source is not at EOF")
	}
	if !g.draining {
		g.draining = true
		g.remaining = g.latency
	}
	return nil
}

func (g *studioGraph) drain(outLeft, outRight []float32) int {
	if !g.draining {
		return 0
	}
	count := min(len(outLeft), len(outRight), g.remaining)
	for i := range count {
		outLeft[i], outRight[i] = g.processFrame(0, 0)
	}
	g.remaining -= count
	return count
}
