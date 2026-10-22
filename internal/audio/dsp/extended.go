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

// MultibandParams uses complementary first-order bands, not linear-phase FIRs.
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
	splitAlpha                                          [2]float64
	splitState                                          [2][2]float64
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
	x.splitAlpha[0] = math.Exp(-2 * math.Pi * clampFreq(e.sampleRate, e.params.Multiband.LowMidHz) / e.sampleRate)
	x.splitAlpha[1] = math.Exp(-2 * math.Pi * clampFreq(e.sampleRate, e.params.Multiband.MidHighHz) / e.sampleRate)
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
		for i, a := range x.splitAlpha {
			x.splitState[i][ch] = a*x.splitState[i][ch] + (1-a)*v
		}
		bands[0][ch] = x.splitState[0][ch]
		bands[1][ch] = x.splitState[1][ch] - x.splitState[0][ch]
		bands[2][ch] = v - x.splitState[1][ch]
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
		wet := 0.0
		for _, s := range subs {
			e.extended.colorLP[ch] = e.extended.colorAlpha*e.extended.colorLP[ch] + (1-e.extended.colorAlpha)*s
			low := e.extended.colorLP[ch]
			shaped := s
			bias := 0.0
			if e.params.Saturation.Character == SatTube {
				bias = .12
			}
			if e.params.Saturation.Character == SatTape {
				shaped = s - .12*amt*(s-low)
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
			if e.params.Saturation.Character == SatTransformer {
				value += s - low
			}
			wet += value
		}
		mixed := (1-amt)*v + amt*wet*.5
		dc := mixed - e.dcPrevX[ch] + e.stages.satDCR*e.dcPrevY[ch]
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
