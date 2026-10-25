package dsp

import (
	"errors"
	"math"
)

// DeHarshParams controls a linked dynamic band cut, independent of legacy repair.
type DeHarshParams struct {
	Enabled     bool    `json:"enabled"`
	FrequencyHz float64 `json:"frequencyHz"`
	ThresholdDB float64 `json:"thresholdDb"`
	RangeDB     float64 `json:"rangeDb"`
}

// DynamicsBandParams controls one linked stereo dynamics band.
type DynamicsBandParams struct {
	ThresholdDB float64 `json:"thresholdDb"`
	Ratio       float64 `json:"ratio"`
	AttackMS    float64 `json:"attackMs"`
	ReleaseMS   float64 `json:"releaseMs"`
	MakeupDB    float64 `json:"makeupDb"`
}

// MultibandParams splits three bands with 24 dB/oct Linkwitz-Riley crossovers.
// The low band passes through the upper crossover's all-pass so idle bands sum
// to a flat-magnitude all-pass; the split is minimum-phase, not linear-phase.
type MultibandParams struct {
	Enabled   bool                  `json:"enabled"`
	LowMidHz  float64               `json:"lowMidHz"`
	MidHighHz float64               `json:"midHighHz"`
	Bands     [3]DynamicsBandParams `json:"bands"`
}

type extendedState struct {
	currentMid, currentSide, gainSmooth                 float64
	midGain, sideGain                                   float64
	autoFast, autoSlow, autoMemory                      float64
	harshCoeffs                                         svfCoeffs
	harshState                                          [2]svfState
	harshEnvelope, harshGain, harshAttack, harshRelease float64
	split                                               [2]svfCoeffs
	split1Low, split1High, split2Low, split2High        [2][2]svfState
	lowPhaseLow, lowPhaseHigh                           [2][2]svfState
	bandEnvelope                                        [3]float64
	bandAttack, bandRelease, bandMakeup                 [3]float64
	colorLP                                             [2]float64
	colorAlpha                                          float64
}

func (e *Engine) recomputeExtended() {
	x := &e.extended
	if x.currentMid == 0 && x.currentSide == 0 {
		x.currentMid = 1
		x.currentSide = 1
	}
	x.gainSmooth = math.Exp(-1 / (.005 * e.sampleRate))
	x.midGain, x.sideGain = dbToLin(e.params.Stereo.MidGainDB), dbToLin(e.params.Stereo.SideGainDB)
	x.autoFast = math.Exp(-2.5 / (.08 * e.sampleRate))
	x.autoSlow = math.Exp(-2.5 / (.8 * e.sampleRate))
	x.autoMemory = math.Exp(-1 / (.5 * e.sampleRate))
	x.harshCoeffs = computeBandpassSVF(e.sampleRate, e.params.DeHarsh.FrequencyHz, 1.2)
	x.harshAttack = math.Exp(-1 / (.005 * e.sampleRate))
	x.harshRelease = math.Exp(-1 / (.1 * e.sampleRate))
	x.split[0] = computeButterworthSVF(e.sampleRate, e.params.Multiband.LowMidHz)
	x.split[1] = computeButterworthSVF(e.sampleRate, e.params.Multiband.MidHighHz)
	for i, b := range e.params.Multiband.Bands {
		x.bandAttack[i] = math.Exp(-2.5 / (math.Max(1, b.AttackMS) * .001 * e.sampleRate))
		x.bandRelease[i] = math.Exp(-2.5 / (math.Max(20, b.ReleaseMS) * .001 * e.sampleRate))
		x.bandMakeup[i] = dbToLin(b.MakeupDB)
	}
	x.colorAlpha = math.Exp(-2 * math.Pi * 180 / (2 * e.sampleRate))
}

func (e *Engine) processDeHarsh(l, r float64) (float64, float64) {
	x := &e.extended
	bl := processSVF(x.harshCoeffs, &x.harshState[0], l)
	br := processSVF(x.harshCoeffs, &x.harshState[1], r)
	bl /= 1.2
	br /= 1.2
	peak := math.Max(math.Abs(bl), math.Abs(br))
	coeff := x.harshRelease
	if peak > x.harshEnvelope {
		coeff = x.harshAttack
	}
	x.harshEnvelope = coeff*x.harshEnvelope + (1-coeff)*peak
	reduction := math.Min(e.params.DeHarsh.RangeDB, math.Max(0, linToDB(x.harshEnvelope)-e.params.DeHarsh.ThresholdDB)*.75)
	target := 1 - dbToLin(-reduction)
	x.harshGain = x.harshAttack*x.harshGain + (1-x.harshAttack)*target
	return l - bl*x.harshGain, r - br*x.harshGain
}

func (e *Engine) processMultiband(l, r float64) (float64, float64) {
	x := &e.extended
	input := [2]float64{l, r}
	var bands [3][2]float64
	for ch, v := range input {
		low := linkwitzRiley(x.split[0], &x.split1Low[ch], v, true)
		rest := linkwitzRiley(x.split[0], &x.split1High[ch], v, false)
		bands[0][ch] = linkwitzRiley(x.split[1], &x.lowPhaseLow[ch], low, true) + linkwitzRiley(x.split[1], &x.lowPhaseHigh[ch], low, false)
		bands[1][ch] = linkwitzRiley(x.split[1], &x.split2Low[ch], rest, true)
		bands[2][ch] = linkwitzRiley(x.split[1], &x.split2High[ch], rest, false)
	}
	var out [2]float64
	for i, b := range e.params.Multiband.Bands {
		peak := math.Max(math.Abs(bands[i][0]), math.Abs(bands[i][1]))
		reduction := math.Max(0, linToDB(peak)-b.ThresholdDB) * (1 - 1/math.Max(1, b.Ratio))
		coeff := x.bandRelease[i]
		if reduction > x.bandEnvelope[i] {
			coeff = x.bandAttack[i]
		}
		x.bandEnvelope[i] = coeff*x.bandEnvelope[i] + (1-coeff)*reduction
		gain := dbToLin(-x.bandEnvelope[i]) * x.bandMakeup[i]
		out[0] += bands[i][0] * gain
		out[1] += bands[i][1] * gain
	}
	return out[0], out[1]
}

// linkwitzRiley runs one fourth-order Linkwitz-Riley section: two cascaded
// Butterworth stages sharing one coefficient set. Low and high outputs are
// -6.02 dB at the crossover and sum to an all-pass.
func linkwitzRiley(c svfCoeffs, s *[2]svfState, v float64, low bool) float64 {
	for stage := range s {
		l, h := processSVFLowHigh(c, &s[stage], v)
		if low {
			v = l
		} else {
			v = h
		}
	}
	return v
}

// These are original, bounded coloration curves, not hardware circuit emulations.
// ADAA at two interpolated substeps reduces nonlinear aliasing; the inexpensive
// averaging decimator is not a brick-wall reconstruction filter.
func (e *Engine) processNewSaturation(l, r float64) (float64, float64) {
	amt := e.stages.satAmount
	drive := 1 + 3*amt
	inputs := [2]float64{l, r}
	var output [2]float64
	for ch, v := range inputs {
		subs := [2]float64{.5 * (e.satPrevIn[ch] + v), v}
		e.satPrevIn[ch] = v
		var adaa, shapedSub [2]float64
		var transformerHigh float64
		prev := e.satPrevX[ch]
		for i, s := range subs {
			// Explicit conversions keep these linear tone terms FMA-free.
			e.extended.colorLP[ch] = float64(e.extended.colorAlpha*e.extended.colorLP[ch]) + float64((1-e.extended.colorAlpha)*s)
			low := e.extended.colorLP[ch]
			shaped := s
			bias := 0.0
			if e.params.Saturation.Character == SatTube {
				bias = .12
			}
			if e.params.Saturation.Character == SatTape {
				shaped = s - float64(.12*amt*(s-low))
			}
			if e.params.Saturation.Character == SatTransformer {
				shaped = low
			}
			// Exact integral of (tanh(d*x+b)-tanh(b))/(d*sech(b)^2).
			biasValue := math.Tanh(bias)
			norm := drive * (1 - biasValue*biasValue)
			integral := (adaaThickIntegral(shaped+bias/drive, drive) - adaaThickIntegral(bias/drive, drive) - biasValue*shaped) / norm
			delta := shaped - e.satPrevX[ch]
			value := (math.Tanh(drive*shaped+bias) - biasValue) / norm
			if math.Abs(delta) > 1e-6 {
				value = (integral - e.satPrevF1[ch]) / delta
			}
			e.satPrevX[ch], e.satPrevF1[ch] = shaped, integral
			adaa[i], shapedSub[i] = value, shaped
			if e.params.Saturation.Character == SatTransformer {
				transformerHigh = s - low
			}
		}
		// The curve is normalized to unity slope at zero; see saturationWet.
		wet := float64(e.stages.satMakeup*saturationWet(adaa[0], adaa[1], 1, prev, shapedSub[0], shapedSub[1])) + transformerHigh
		mixed := float64((1-amt)*v) + float64(amt*wet)
		dc := (mixed - e.dcPrevX[ch]) + float64(e.stages.satDCR*e.dcPrevY[ch])
		e.dcPrevX[ch], e.dcPrevY[ch] = mixed, dc
		output[ch] = dc
	}
	return output[0], output[1]
}

func validateExtended(p Params) error {
	d := p.DeHarsh
	if d != (DeHarshParams{}) && (!finite(d.FrequencyHz) || d.FrequencyHz < 1000 || d.FrequencyHz > 12000 || !finite(d.ThresholdDB) || d.ThresholdDB < -60 || d.ThresholdDB > 0 || !finite(d.RangeDB) || d.RangeDB < 0 || d.RangeDB > 12) {
		return errors.New("invalid de-harsh parameters")
	}
	m := p.Multiband
	if m == (MultibandParams{}) {
		return nil
	}
	if !finite(m.LowMidHz) || m.LowMidHz < 40 || m.LowMidHz > 1000 || !finite(m.MidHighHz) || m.MidHighHz < 1500 || m.MidHighHz > 12000 || m.MidHighHz <= m.LowMidHz {
		return errors.New("invalid multiband crossovers")
	}
	for _, b := range m.Bands {
		if !finite(b.ThresholdDB) || b.ThresholdDB < -60 || b.ThresholdDB > 0 || !finite(b.Ratio) || b.Ratio < 1 || b.Ratio > 8 || !finite(b.AttackMS) || b.AttackMS < 1 || b.AttackMS > 200 || !finite(b.ReleaseMS) || b.ReleaseMS < 20 || b.ReleaseMS > 2000 || !finite(b.MakeupDB) || b.MakeupDB < -12 || b.MakeupDB > 12 {
			return errors.New("invalid multiband dynamics")
		}
	}
	return nil
}

// Rebase the antiderivative history under the new curve before its next divided
// difference. Otherwise a drive/model edit can turn a constant offset into a spike.
func (e *Engine) rebaseSaturation() {
	for ch, x := range e.satPrevX {
		switch e.params.Saturation.Character {
		case SatWarm:
			_, e.satPrevF1[ch] = adaaWarmWave(x, e.stages.satDrive)
		case SatCrisp:
			e.satPrevF1[ch] = adaaThickIntegral(x, e.stages.satDrive*1.1)
		case SatTube, SatTape, SatTransformer:
			drive := 1 + 3*e.stages.satAmount
			bias := 0.0
			if e.params.Saturation.Character == SatTube {
				bias = .12
			}
			b := math.Tanh(bias)
			e.satPrevF1[ch] = (adaaThickIntegral(x+bias/drive, drive) - adaaThickIntegral(bias/drive, drive) - b*x) / (drive * (1 - b*b))
		case SatClean, SatThick:
			e.satPrevF1[ch] = adaaThickIntegral(x, e.stages.satDrive)
		}
	}
}

// Clear histories when their signal path stops running. Frozen delay samples
// must not be replayed after a later reactivation. Running stages, coefficients,
// M/S gain smoothing, monitoring calibration and dither state are preserved.
func (e *Engine) clearStoppedStageHistory(prev Params) {
	next := e.params
	all := !prev.Bypass && next.Bypass
	if all || (prev.EQEnabled && !next.EQEnabled) {
		e.eqState = [NumEQBands][2]svfState{}
	}
	wasComp := prev.Compressor.Enabled && (prev.Compressor.Ratio > 1.0001 || math.Abs(prev.Compressor.MakeupDB) >= 1e-7)
	isComp := next.Compressor.Enabled && (next.Compressor.Ratio > 1.0001 || math.Abs(next.Compressor.MakeupDB) >= 1e-7)
	if all || (wasComp && !isComp) {
		e.compPeakEnv, e.compEnvDB, e.compSlowDB, e.lastGRDB = 0, 0, 0, 0
	}
	if prev.Compressor.AutoRelease && !next.Compressor.AutoRelease {
		e.compSlowDB = 0
	}
	if all || (wasComp && !isComp) || (prev.Compressor.SidechainHPFHz > 10 && next.Compressor.SidechainHPFHz <= 10) {
		e.scHPFState = [2][2]svfState{}
	}
	wasSat := prev.Saturation.Enabled && prev.Saturation.Amount >= 1e-5 && prev.Saturation.Character != SatClean
	isSat := next.Saturation.Enabled && next.Saturation.Amount >= 1e-5 && next.Saturation.Character != SatClean
	if all || (wasSat && !isSat) {
		e.satPrevX, e.satPrevF1, e.satPrevIn = [2]float64{}, [2]float64{}, [2]float64{}
		e.dcPrevX, e.dcPrevY = [2]float64{}, [2]float64{}
	}
	// Model-specific filters stop advancing when another processing path is
	// selected. Shared ADAA/input/DC histories still belong to the running chain.
	if all || (wasSat && !isSat) || (prev.Saturation.Character == SatCrisp && next.Saturation.Character != SatCrisp) {
		e.ironLP, e.ironHP = [2]float64{}, [2]float64{}
	}
	wasColor := prev.Saturation.Character == SatTube || prev.Saturation.Character == SatTape || prev.Saturation.Character == SatTransformer
	isColor := next.Saturation.Character == SatTube || next.Saturation.Character == SatTape || next.Saturation.Character == SatTransformer
	if all || (wasSat && !isSat) || (wasColor && !isColor) {
		e.extended.colorLP = [2]float64{}
	}
	if all || (prev.Stereo.Enabled && prev.Stereo.MonoBass && (!next.Stereo.Enabled || !next.Stereo.MonoBass)) {
		e.xoverSide = [4]svfState{}
		e.xoverLow, e.xoverHigh = [2][2]svfState{}, [2][2]svfState{}
	}
	if all || (prev.Repair.Enabled && prev.Repair.DeEssDB > 1e-5 && (!next.Repair.Enabled || next.Repair.DeEssDB <= 1e-5)) {
		e.deEssState, e.deEssEnv = [2]svfState{}, 0
	}
	if all || (prev.Repair.Enabled && math.Abs(prev.Repair.TransientDB) > 1e-5 && (!next.Repair.Enabled || math.Abs(next.Repair.TransientDB) <= 1e-5)) {
		e.transFast, e.transSlow = 0, 0
	}
	if all || (prev.DeHarsh.Enabled && !next.DeHarsh.Enabled) {
		e.extended.harshState = [2]svfState{}
		e.extended.harshEnvelope, e.extended.harshGain = 0, 0
	}
	if all || (prev.Multiband.Enabled && !next.Multiband.Enabled) {
		x := &e.extended
		x.split1Low, x.split1High, x.split2Low, x.split2High = [2][2]svfState{}, [2][2]svfState{}, [2][2]svfState{}, [2][2]svfState{}
		x.lowPhaseLow, x.lowPhaseHigh = [2][2]svfState{}, [2][2]svfState{}
		e.extended.bandEnvelope = [3]float64{}
	}
	if all || (prev.Limiter.Enabled && !next.Limiter.Enabled) {
		e.limPrevL, e.limPrevR = [3]float64{}, [3]float64{}
		e.limEnvLin, e.lastLimGRDB = 1, 0
	}
}
