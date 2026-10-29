package dsp

import "math"

// Algorithm 3 processes only saturation at 2x. The 129-tap half-band prototype
// has cutoff 0.25 cycles per high-rate sample, Kaiser beta 7.85726, passband
// <=0.2275 and stopband >=0.2725. The center is exactly 0.5; the odd taps
// are normalized to sum to 0.5. Symmetry and alternating zero taps reduce
// each interpolation/decimation pair to 64 coefficient products per channel.
// Both filters together delay 64 base-rate frames. Filter rejection is not
// a bound on nonlinear aliasing already generated above the 2x Nyquist limit.
const saturationLatency = 64

var halfBandOdd = [32]float64{
	-2.07815924523811567e-05,
	4.18106013680354346e-05,
	-7.2971533331974724e-05,
	0.000117111357890497075,
	-0.000177524188474815348,
	0.000257975052852461688,
	-0.000362722788579092109,
	0.000496543965469570399,
	-0.000664760751504454503,
	0.000873276968558587912,
	-0.00112862835826973225,
	0.00143805549795172319,
	-0.00180961119270843236,
	0.00225231904124171493,
	-0.00277640708090867803,
	0.00339365138969485334,
	-0.00411788170737259571,
	0.00496572884914845813,
	-0.00595773975907690212,
	0.00712006522652340948,
	-0.00848706640922529398,
	0.0101054484315985724,
	-0.0120410399032173099,
	0.0143903886030124425,
	-0.017301656978684507,
	0.0210148181402383429,
	-0.0259456985274892256,
	0.03288205073341878,
	-0.0435156885352968453,
	0.062251621084295182,
	-0.105253459836876631,
	0.318032774200206203,
}

type halfBandInterpolator struct {
	x  [64]float64
	at int
}

func (f *halfBandInterpolator) process(x float64) (float64, float64) {
	f.x[f.at] = x
	even := f.x[(f.at-32)&63]
	var odd float64
	for k, coefficient := range halfBandOdd {
		pair := f.x[(f.at-k)&63] + f.x[(f.at-(63-k))&63]
		odd += float64((2 * coefficient) * pair)
	}
	f.at = (f.at + 1) & 63
	return even, odd
}

type halfBandDecimator struct {
	x  [128]float64
	at int
}

func (f *halfBandDecimator) process(even, odd float64) float64 {
	f.x[f.at] = even
	out := .5 * f.x[(f.at-64)&127]
	for k, coefficient := range halfBandOdd {
		pair := f.x[(f.at-(2*k+1))&127] + f.x[(f.at-(127-2*k))&127]
		out += float64(coefficient * pair)
	}
	f.at = (f.at + 1) & 127
	f.x[f.at] = odd
	f.at = (f.at + 1) & 127
	return out
}

// The control ring travels with the source. Saturation uses the interpolator
// center (32 frames old); stereo follows both filters (64 frames old).
// Gain/EQ/compression retain the original source clock in processBlock.
type oversampledControls struct {
	saturation                      SaturationParams
	amount, drive, makeup           float64
	stereo                          StereoParams
	width, midGain, sideGain        float64
	crossover                       svfCoeffs
	limiter                         LimiterParams
	ceiling, release, sampleCeiling float64
	bypass, original                bool
	dither                          int
}

type saturationCurveState struct {
	previous, low [2]float64
}

type oversampledState struct {
	up                      [2]halfBandInterpolator
	down                    [2]halfBandDecimator
	dry, raw                [64][2]float64
	controls                [64]oversampledControls
	at, pending, drainStage int
	// Each character has independent shaping/integral history. The active
	// character resets on a switch, so frozen audio is never replayed.
	curves                     [6]saturationCurveState
	active                     SatCharacter
	dcX, dcY                   [2]float64
	stereoLow, stereoHigh      [2][2]svfState
	stereoPrevious             StereoParams
	mid, side                  float64
	crossover                  svfCoeffs
	transformerAlpha           float64
	limiterMode, limiterPrimed bool
}

func (e *Engine) oversampledControls(width float64) oversampledControls {
	p, c := &e.params, &e.stages
	return oversampledControls{
		saturation: p.Saturation, amount: c.satAmount, drive: c.satDrive, makeup: c.satMakeup,
		stereo: p.Stereo, width: width, midGain: e.extended.midGain, sideGain: e.extended.sideGain,
		crossover: e.oversampled.crossover, limiter: p.Limiter,
		ceiling: c.limiterCeiling, release: c.limiterRelease, sampleCeiling: c.limiterSampleCeiling,
		bypass: p.Bypass, original: p.ABOriginal, dither: p.DitherBits,
	}
}

func curveIndex(character SatCharacter) int {
	switch character {
	case SatWarm:
		return 0
	case SatThick:
		return 1
	case SatCrisp:
		return 2
	case SatTube:
		return 3
	case SatTape:
		return 4
	case SatTransformer:
		return 5
	case SatClean:
		return 0
	default:
		return 0
	}
}

// oversampledADAA evaluates the divided antiderivative difference under the
// current curve. The centered log-cosh identity avoids subtracting nearly equal
// integrals in the Transformer low band: log(cosh(m+d)/cosh(m-d)) is
// 2*atanh(tanh(m)*tanh(d)). Small d uses its second-order limit. This also
// rebases both endpoints on a parameter edit without storing an old integral.
func oversampledADAA(x, previous float64, c oversampledControls) float64 {
	if c.saturation.Character == SatWarm {
		_, integral := adaaWarmWave(x, c.drive)
		if delta := x - previous; math.Abs(delta) > 1e-5 {
			_, before := adaaWarmWave(previous, c.drive)
			return (integral - before) / delta
		}
		value, _ := adaaWarmWave(.5*(x+previous), c.drive)
		return value
	}
	drive, bias := c.drive, 0.0
	if c.saturation.Character == SatCrisp {
		drive *= 1.1
	}
	if c.saturation.Character == SatTube || c.saturation.Character == SatTape || c.saturation.Character == SatTransformer {
		drive = 1 + float64(3*c.amount)
	}
	if c.saturation.Character == SatTube {
		bias = .12
	}
	b := math.Tanh(bias)
	norm := drive * (1 - float64(b*b))
	middle := math.Tanh(float64(drive*(.5*(x+previous))) + bias)
	d := drive * (.5 * (x - previous))
	var average float64
	if math.Abs(d) < 1e-4 {
		// tanh''(middle argument)=-2*tanh*(1-tanh^2).
		average = middle - float64((d*d/3)*middle*(1-float64(middle*middle)))
	} else {
		product := middle * math.Tanh(d)
		if math.Abs(product) < .999999999 {
			average = math.Atanh(product) / d
		} else {
			average = (adaaThickIntegral(x+bias/drive, drive) - adaaThickIntegral(previous+bias/drive, drive)) / (x - previous)
		}
	}
	return (average - b) / norm
}

func (o *oversampledState) residual(ch int, input float64, c oversampledControls, alpha, dcR float64) float64 {
	if c.bypass || !c.saturation.Enabled || c.amount < 1e-7 || c.saturation.Character == SatClean {
		o.active = ""
		o.dcX, o.dcY = [2]float64{}, [2]float64{}
		return 0
	}
	state := &o.curves[curveIndex(c.saturation.Character)]
	if o.active != c.saturation.Character {
		*state = saturationCurveState{}
		o.active = c.saturation.Character
	}
	state.low[ch] = float64(alpha*state.low[ch]) + float64((1-alpha)*input)
	shaped := input
	switch c.saturation.Character {
	case SatTape:
		shaped = input - float64(.12*c.amount*(input-state.low[ch]))
	case SatTransformer:
		shaped = state.low[ch]
	case SatCrisp:
		shaped = input + float64(.35*c.amount*(input-state.low[ch])) + float64(.20*c.amount*state.low[ch])
	case SatWarm, SatThick, SatTube, SatClean:
	}
	previous := state.previous[ch]
	value := oversampledADAA(shaped, previous, c)
	state.previous[ch] = shaped
	// Restore ADAA's linear response at 2x, then decimate the nonlinear
	// residual. The dry signal has an exact 64-frame delay at every setting.
	wet := float64(c.makeup * (value + float64(.5*(shaped-previous))))
	if c.saturation.Character == SatTransformer {
		wet += input - shaped
	}
	residual := c.amount * (wet - input)
	blocked := (residual - o.dcX[ch]) + float64(dcR*o.dcY[ch])
	o.dcX[ch], o.dcY[ch] = residual, blocked
	return blocked
}

func (e *Engine) oversampledStage(l, r, rawL, rawR float64, c oversampledControls) (float64, float64, float64, float64, oversampledControls) {
	o := &e.oversampled
	post := o.controls[o.at]
	saturation := o.controls[(o.at+32)&63]
	dry, raw := o.dry[o.at], o.raw[o.at]
	o.dry[o.at], o.raw[o.at] = [2]float64{l, r}, [2]float64{rawL, rawR}
	o.controls[o.at] = c
	o.at = (o.at + 1) & 63
	var out [2]float64
	alpha := e.extended.colorAlpha
	if saturation.saturation.Character == SatCrisp {
		alpha = .96
	}
	if saturation.saturation.Character == SatTransformer {
		alpha = e.oversampled.transformerAlpha
	}
	dcR := 1 - 2*math.Pi*20/(2*e.sampleRate)
	for ch, input := range [2]float64{l, r} {
		even, odd := o.up[ch].process(input)
		even = o.residual(ch, even, saturation, alpha, dcR)
		odd = o.residual(ch, odd, saturation, alpha, dcR)
		out[ch] = dry[ch] + o.down[ch].process(even, odd)
	}
	return out[0], out[1], raw[0], raw[1], post
}

func (e *Engine) oversampledStereo(l, r float64, c oversampledControls) (float64, float64) {
	o := &e.oversampled
	if !c.stereo.Enabled || c.bypass {
		o.stereoLow, o.stereoHigh = [2][2]svfState{}, [2][2]svfState{}
		o.mid, o.side = 1, 1
		o.stereoPrevious = c.stereo
		return l, r
	}
	if !o.stereoPrevious.MonoBass || !o.stereoPrevious.Enabled {
		o.stereoLow, o.stereoHigh = [2][2]svfState{}, [2][2]svfState{}
	}
	o.stereoPrevious = c.stereo
	if o.mid == 0 && o.side == 0 {
		o.mid, o.side = 1, 1
	}
	smooth := e.extended.gainSmooth
	o.mid = float64(smooth*o.mid) + float64((1-smooth)*c.midGain)
	o.side = float64(smooth*o.side) + float64((1-smooth)*c.sideGain)
	mid, side := .5*(l+r)*o.mid, .5*(l-r)*o.side
	if c.stereo.MonoBass {
		// Matched LR4 reconstruction on Mid and HP on Side. Two cascaded
		// Butterworth sections per branch, at the requested crossover.
		mid = linkwitzRiley(c.crossover, &o.stereoLow[0], mid, true) + linkwitzRiley(c.crossover, &o.stereoHigh[0], mid, false)
		side = linkwitzRiley(c.crossover, &o.stereoHigh[1], side, false)
	}
	side *= c.width
	return mid + side, mid - side
}

func (e *Engine) oversampledOutput(l, r, rawL, rawR float64, c oversampledControls) (float32, float32) {
	// Existing limiter arithmetic is shared. Only its controls are delayed
	// to the saturation output clock; upstream controls remain current.
	limiter, original, dither := e.params.Limiter, e.params.ABOriginal, e.params.DitherBits
	ceiling, release, sampleCeiling := e.stages.limiterCeiling, e.stages.limiterRelease, e.stages.limiterSampleCeiling
	e.params.Limiter, e.params.ABOriginal, e.params.DitherBits = c.limiter, c.original, c.dither
	e.stages.limiterCeiling, e.stages.limiterRelease, e.stages.limiterSampleCeiling = c.ceiling, c.release, c.sampleCeiling
	mode := c.limiter.Enabled && c.limiter.TruePeak && !c.bypass
	if e.oversampled.limiterPrimed && mode != e.oversampled.limiterMode {
		e.limEnvLin = 1
		e.limPrevL, e.limPrevR = [3]float64{}, [3]float64{}
	}
	e.oversampled.limiterPrimed, e.oversampled.limiterMode = true, mode
	var outL, outR float32
	if c.bypass {
		outL, outR = e.truePeakPassthrough(float32(l), float32(r))
	} else {
		l, r, rawL, rawR = e.processTruePeakStage(l, r, rawL, rawR, c.limiter.Enabled)
		outL, outR = e.finishSample(l, r, rawL, rawR, c.limiter.Enabled)
	}
	e.params.Limiter, e.params.ABOriginal, e.params.DitherBits = limiter, original, dither
	e.stages.limiterCeiling, e.stages.limiterRelease, e.stages.limiterSampleCeiling = ceiling, release, sampleCeiling
	return outL, outR
}

// Flush the saturation/stereo pipeline before flushing the limiter. Once the
// last source-aligned frame has entered the limiter, truncate the FIR/IIR tail
// and guard just as a finite exported file is truncated. Partial drains retain
// this boundary; detached drains restore the entire state, including controls.
func (e *Engine) drainOversampled(outL, outR []float32) int {
	o := &e.oversampled
	n := min(len(outL), len(outR), o.pending)
	control := o.controls[(o.at-1)&63]
	for i := 0; i < n; i++ {
		var l, r, rawL, rawR float64
		post := control
		if o.drainStage > 0 {
			l, r, rawL, rawR, post = e.oversampledStage(0, 0, 0, 0, control)
			l, r = e.oversampledStereo(l, r, post)
			o.drainStage--
		} else {
			e.truePeak.guard = nyquistGuard{}
		}
		outL[i], outR[i] = e.oversampledOutput(l, r, rawL, rawR, post)
	}
	o.pending -= n
	return n
}

func (e *Engine) configureOversampling() {
	e.oversampled.crossover = computeButterworthSVF(e.sampleRate, e.params.Stereo.CrossoverHz)
	// Keep Transformer excitation in the bass. At 160 Hz, the accurate FIR
	// interpolator retains the <=0.1 dB high-band small-signal response bound.
	e.oversampled.transformerAlpha = math.Exp(-2 * math.Pi * 160 / (2 * e.sampleRate))
}
