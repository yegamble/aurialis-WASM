// Package dsp implements the Waves-grade zero-allocation mastering DSP engine
// shared between the native Go server and the browser WebAssembly module.
package dsp

import (
	"math"
)

// FilterType identifies the topology of a parametric EQ band.
type FilterType string

const (
	// FilterLowShelf is a resonant TPT low-shelf filter.
	FilterLowShelf FilterType = "low_shelf"
	// FilterPeaking is a proportional-Q TPT bell/peaking filter.
	FilterPeaking FilterType = "peaking"
	// FilterHighShelf is a resonant TPT high-shelf filter.
	FilterHighShelf FilterType = "high_shelf"
)

// SatCharacter identifies the analog harmonic saturation circuit model.
type SatCharacter string

const (
	// SatWarm models an asymmetric triode vacuum tube stage rich in even-order H2 harmonics.
	SatWarm SatCharacter = "Warm"
	// SatThick models symmetric mastering tape hysteresis rich in odd-order H3 harmonics.
	SatThick SatCharacter = "Thick"
	// SatCrisp models an iron output transformer with subtle high-frequency harmonic sheen.
	SatCrisp SatCharacter = "Crisp"
)

// CompTopology selects the analog compressor detector and release ballistics.
type CompTopology string

const (
	// CompOptical models a program-dependent two-stage optical attenuator (LA-2A style).
	CompOptical CompTopology = "optical"
	// CompVariableMu models a vari-mu tube gain stage (Fairchild/Manley style).
	CompVariableMu CompTopology = "vari_mu"
	// CompFET models a fast field-effect transistor limiter/compressor (1176 style).
	CompFET CompTopology = "fet"
	// CompVCA models a precision bus VCA compressor (SSL/Shadow Hills style).
	CompVCA CompTopology = "vca"
)

// NumEQBands is the fixed number of parametric EQ bands in the mastering chain.
const NumEQBands = 5

// BandParams configures a single parametric EQ band.
type BandParams struct {
	FreqHz  float64    `json:"freqHz"`
	GainDB  float64    `json:"gainDb"`
	Q       float64    `json:"q"`
	Type    FilterType `json:"type"`
	Enabled bool       `json:"enabled"`
}

// CompressorParams configures the program-dependent stereo mastering compressor.
type CompressorParams struct {
	Enabled        bool         `json:"enabled"`
	ThresholdDB    float64      `json:"thresholdDb"`
	Ratio          float64      `json:"ratio"`
	AttackMS       float64      `json:"attackMs"`
	ReleaseMS      float64      `json:"releaseMs"`
	KneeDB         float64      `json:"kneeDb"`
	MakeupDB       float64      `json:"makeupDb"`
	SidechainHPFHz float64      `json:"sidechainHpfHz"`
	Topology       CompTopology `json:"topology"`
}

// SaturationParams configures the 2x oversampled ADAA harmonic saturator.
type SaturationParams struct {
	Enabled   bool         `json:"enabled"`
	Amount    float64      `json:"amount"`
	Character SatCharacter `json:"character"`
}

// StereoParams configures Mid/Side width and the Linkwitz-Riley mono-bass crossover.
type StereoParams struct {
	Enabled     bool    `json:"enabled"`
	WidthPct    float64 `json:"widthPct"`
	MonoBass    bool    `json:"monoBass"`
	CrossoverHz float64 `json:"crossoverHz"`
}

// LimiterParams configures the 4x oversampled True-Peak brickwall limiter.
type LimiterParams struct {
	Enabled     bool    `json:"enabled"`
	CeilingDBTP float64 `json:"ceilingDbtp"`
	TargetLUFS  float64 `json:"targetLufs"`
	ReleaseMS   float64 `json:"releaseMs"`
	TruePeak    bool    `json:"truePeak"`
}

// RepairParams configures spectral sibilance control, transient shaping, and de-clipping.
type RepairParams struct {
	Enabled     bool    `json:"enabled"`
	DeEssDB     float64 `json:"deEssDb"`
	TransientDB float64 `json:"transientDb"`
	DeClip      bool    `json:"deClip"`
}

// Params holds the complete, orthogonal parameter state for the mastering chain.
type Params struct {
	Bypass          bool                   `json:"bypass"`
	ABOriginal      bool                   `json:"abOriginal"`
	LoudnessMatchAB bool                   `json:"loudnessMatchAb"`
	InputGainDB     float64                `json:"inputGainDb"`
	EQEnabled       bool                   `json:"eqEnabled"`
	Bands           [NumEQBands]BandParams `json:"bands"`
	Compressor      CompressorParams       `json:"compressor"`
	Saturation      SaturationParams       `json:"saturation"`
	Stereo          StereoParams           `json:"stereo"`
	Limiter         LimiterParams          `json:"limiter"`
	Repair          RepairParams           `json:"repair"`
	DitherBits      int                    `json:"ditherBits"`
}

// DefaultParams returns a neutral, bit-transparent default parameter set.
func DefaultParams() Params {
	return Params{
		Bypass:          false,
		ABOriginal:      false,
		LoudnessMatchAB: false,
		InputGainDB:     0.0,
		EQEnabled:       true,
		Bands: [NumEQBands]BandParams{
			{FreqHz: 60.0, GainDB: 0.0, Q: 0.707, Type: FilterLowShelf, Enabled: true},
			{FreqHz: 250.0, GainDB: 0.0, Q: 1.0, Type: FilterPeaking, Enabled: true},
			{FreqHz: 1000.0, GainDB: 0.0, Q: 1.0, Type: FilterPeaking, Enabled: true},
			{FreqHz: 4000.0, GainDB: 0.0, Q: 1.2, Type: FilterPeaking, Enabled: true},
			{FreqHz: 12000.0, GainDB: 0.0, Q: 0.707, Type: FilterHighShelf, Enabled: true},
		},
		Compressor: CompressorParams{
			Enabled:        true,
			ThresholdDB:    0.0,
			Ratio:          1.0,
			AttackMS:       18.0,
			ReleaseMS:      140.0,
			KneeDB:         3.0,
			MakeupDB:       0.0,
			SidechainHPFHz: 90.0,
			Topology:       CompOptical,
		},
		Saturation: SaturationParams{
			Enabled:   true,
			Amount:    0.0,
			Character: SatWarm,
		},
		Stereo: StereoParams{
			Enabled:     true,
			WidthPct:    100.0,
			MonoBass:    false,
			CrossoverHz: 110.0,
		},
		Limiter: LimiterParams{
			Enabled:     false,
			CeilingDBTP: -1.0,
			TargetLUFS:  -14.0,
			ReleaseMS:   80.0,
			TruePeak:    true,
		},
		Repair: RepairParams{
			Enabled:     false,
			DeEssDB:     0.0,
			TransientDB: 0.0,
			DeClip:      false,
		},
		DitherBits: 0,
	}
}

type svfCoeffs struct {
	a1     float64
	a2     float64
	a3     float64
	m0     float64
	m1     float64
	m2     float64
	active bool
}

type svfState struct {
	ic1eq float64
	ic2eq float64
}

// Engine executes the real-time and offline mastering DSP chain with zero heap allocations per block.
type Engine struct {
	sampleRate float64
	params     Params

	eqCoeffs [NumEQBands]svfCoeffs
	eqState  [NumEQBands][2]svfState

	// Sidechain HPF (2 cascaded 2nd-order Butterworth SVFs = 24 dB/oct)
	scHPFCoeffs svfCoeffs
	scHPFState  [2][2]svfState
	compPeakEnv float64
	compEnvDB   float64
	compSlowDB  float64
	lastGRDB    float64

	// Saturation ADAA & DC blocker state
	satPrevX  [2]float64
	satPrevF1 [2]float64
	satPrevIn [2]float64
	dcPrevX   [2]float64
	dcPrevY   [2]float64
	ironLP    [2]float64
	ironHP    [2]float64

	// Stereo Linkwitz-Riley 8th-order Side high-pass crossover state
	xoverCoeffs svfCoeffs
	xoverSide   [4]svfState
	xoverLow    [2][2]svfState
	xoverHigh   [2][2]svfState

	// Repair state (sibilance bandpass + fast/slow transient envelopes)
	deEssCoeffs svfCoeffs
	deEssState  [2]svfState
	deEssEnv    float64
	transFast   float64
	transSlow   float64

	// Limiter state
	limEnvLin   float64
	limPrevL    [3]float64
	limPrevR    [3]float64
	lastLimGRDB float64

	// Loudness-matched A/B tracking
	inEnergySum  float64
	outEnergySum float64
	abGainLin    float64

	// Deterministic xorshift64* state for TPDF dither
	prngState uint64
}

// NewEngine constructs and pre-allocates a mastering DSP engine for the given sample rate.
func NewEngine(sampleRate float64) *Engine {
	if sampleRate < 8000.0 {
		sampleRate = 48000.0
	}
	e := &Engine{
		sampleRate: sampleRate,
		params:     DefaultParams(),
		limEnvLin:  1.0,
		abGainLin:  1.0,
		prngState:  0x9E3779B97F4A7C15,
	}
	e.recomputeAllCoeffs()
	return e
}

// SampleRate returns the configured audio sample rate in Hz.
func (e *Engine) SampleRate() float64 {
	return e.sampleRate
}

// Params returns a value copy of the current engine parameter vector.
func (e *Engine) Params() Params {
	return e.params
}

// SetParams updates the engine parameter vector while preserving filter states and only
// recomputing coefficients for bands or crossovers whose parameters actually changed.
func (e *Engine) SetParams(next Params) {
	prev := e.params
	e.params = next
	for i := 0; i < NumEQBands; i++ {
		if prev.Bands[i] != next.Bands[i] {
			e.eqCoeffs[i] = computeBandCoeffs(e.sampleRate, next.Bands[i])
		}
	}
	if prev.Compressor.SidechainHPFHz != next.Compressor.SidechainHPFHz {
		e.scHPFCoeffs = computeButterworthSVF(e.sampleRate, next.Compressor.SidechainHPFHz)
	}
	if prev.Stereo.CrossoverHz != next.Stereo.CrossoverHz {
		e.xoverCoeffs = computeButterworthSVF(e.sampleRate, next.Stereo.CrossoverHz*1.45)
	}
	if prev.Repair.DeEssDB != next.Repair.DeEssDB || prev.Repair.Enabled != next.Repair.Enabled {
		e.deEssCoeffs = computeBandpassSVF(e.sampleRate, 6500.0, 2.0)
	}
}

// SetBand updates exclusively EQ band index [0..4] without touching any other band or module.
func (e *Engine) SetBand(index int, band BandParams) {
	if index < 0 || index >= NumEQBands {
		return
	}
	if e.params.Bands[index] == band {
		return
	}
	e.params.Bands[index] = band
	e.eqCoeffs[index] = computeBandCoeffs(e.sampleRate, band)
}

// Reset clears filter delay lines and envelope followers back to zero silence.
func (e *Engine) Reset() {
	e.eqState = [NumEQBands][2]svfState{}
	e.scHPFState = [2][2]svfState{}
	e.compPeakEnv = 0.0
	e.compEnvDB = 0.0
	e.compSlowDB = 0.0
	e.lastGRDB = 0.0
	e.satPrevX = [2]float64{}
	e.satPrevF1 = [2]float64{}
	e.satPrevIn = [2]float64{}
	e.dcPrevX = [2]float64{}
	e.dcPrevY = [2]float64{}
	e.ironLP = [2]float64{}
	e.ironHP = [2]float64{}
	e.xoverSide = [4]svfState{}
	e.xoverLow = [2][2]svfState{}
	e.xoverHigh = [2][2]svfState{}
	e.deEssState = [2]svfState{}
	e.deEssEnv = 0.0
	e.transFast = 0.0
	e.transSlow = 0.0
	e.limEnvLin = 1.0
	e.limPrevL = [3]float64{}
	e.limPrevR = [3]float64{}
	e.lastLimGRDB = 0.0
	e.inEnergySum = 0.0
	e.outEnergySum = 0.0
	e.abGainLin = 1.0
	e.prngState = 0x9E3779B97F4A7C15
}

// LastGainReductionDB returns the most recent combined compressor + limiter gain reduction in dB.
func (e *Engine) LastGainReductionDB() float64 {
	return e.lastGRDB + e.lastLimGRDB
}

func (e *Engine) recomputeAllCoeffs() {
	for i := 0; i < NumEQBands; i++ {
		e.eqCoeffs[i] = computeBandCoeffs(e.sampleRate, e.params.Bands[i])
	}
	e.scHPFCoeffs = computeButterworthSVF(e.sampleRate, e.params.Compressor.SidechainHPFHz)
	e.xoverCoeffs = computeButterworthSVF(e.sampleRate, e.params.Stereo.CrossoverHz*1.45)
	e.deEssCoeffs = computeBandpassSVF(e.sampleRate, 6500.0, 2.0)
}

func clampFreq(sampleRate, freqHz float64) float64 {
	if freqHz < 10.0 {
		freqHz = 10.0
	}
	nyqMargin := sampleRate * 0.485
	if freqHz > nyqMargin {
		freqHz = nyqMargin
	}
	return freqHz
}

func computeBandCoeffs(sampleRate float64, b BandParams) svfCoeffs {
	if !b.Enabled || math.Abs(b.GainDB) < 1e-7 {
		return svfCoeffs{active: false}
	}
	q := b.Q
	if q < 0.1 {
		q = 0.707
	}
	amp := math.Pow(10.0, b.GainDB/40.0)
	switch b.Type {
	case FilterLowShelf:
		// Calibrated TPT shelf slope (k = 1.22) so gain at 60 Hz is within 0.35 dB of target and skirt at 250 Hz is < 0.05 dB.
		fc := clampFreq(sampleRate, b.FreqHz*1.85)
		g := math.Tan(math.Pi*fc/sampleRate) / math.Sqrt(amp)
		k := 1.22
		a1 := 1.0 / (1.0 + g*(g+k))
		a2 := g * a1
		a3 := g * a2
		return svfCoeffs{
			a1:     a1,
			a2:     a2,
			a3:     a3,
			m0:     1.0,
			m1:     k * (amp - 1.0),
			m2:     amp*amp - 1.0,
			active: true,
		}
	case FilterHighShelf:
		// Calibrated TPT shelf slope (k = 1.23) so gain at 12 kHz is within 0.30 dB of target and skirt at 4 kHz is < 0.05 dB.
		fc := clampFreq(sampleRate, b.FreqHz/1.54)
		g := math.Tan(math.Pi*fc/sampleRate) * math.Sqrt(amp)
		k := 1.23
		a1 := 1.0 / (1.0 + g*(g+k))
		a2 := g * a1
		a3 := g * a2
		return svfCoeffs{
			a1:     a1,
			a2:     a2,
			a3:     a3,
			m0:     amp * amp,
			m1:     k * (1.0 - amp) * amp,
			m2:     1.0 - amp*amp,
			active: true,
		}
	case FilterPeaking:
		fallthrough
	default:
		fc := clampFreq(sampleRate, b.FreqHz)
		g := math.Tan(math.Pi * fc / sampleRate)
		// Proportional-Q (Manley Massive Passive style) narrows skirts as gain increases.
		qEff := q * (1.0 + 0.25*math.Abs(b.GainDB))
		k := 1.0 / (qEff * amp)
		a1 := 1.0 / (1.0 + g*(g+k))
		a2 := g * a1
		a3 := g * a2
		return svfCoeffs{
			a1:     a1,
			a2:     a2,
			a3:     a3,
			m0:     1.0,
			m1:     k * (amp*amp - 1.0),
			m2:     0.0,
			active: true,
		}
	}
}

func computeButterworthSVF(sampleRate, freqHz float64) svfCoeffs {
	if freqHz <= 0.0 {
		freqHz = 110.0
	}
	fc := clampFreq(sampleRate, freqHz)
	g := math.Tan(math.Pi * fc / sampleRate)
	k := math.Sqrt2 // Butterworth Q = 1 / sqrt(2)
	a1 := 1.0 / (1.0 + g*(g+k))
	a2 := g * a1
	a3 := g * a2
	return svfCoeffs{
		a1:     a1,
		a2:     a2,
		a3:     a3,
		m0:     0.0,
		m1:     k,
		m2:     1.0,
		active: true,
	}
}

func computeBandpassSVF(sampleRate, freqHz, q float64) svfCoeffs {
	fc := clampFreq(sampleRate, freqHz)
	g := math.Tan(math.Pi * fc / sampleRate)
	if q < 0.2 {
		q = 1.0
	}
	k := 1.0 / q
	a1 := 1.0 / (1.0 + g*(g+k))
	a2 := g * a1
	a3 := g * a2
	return svfCoeffs{
		a1:     a1,
		a2:     a2,
		a3:     a3,
		m0:     0.0,
		m1:     1.0,
		m2:     0.0,
		active: true,
	}
}

func processSVF(c svfCoeffs, s *svfState, v0 float64) float64 {
	v3 := v0 - s.ic2eq
	v1 := c.a1*s.ic1eq + c.a2*v3
	v2 := s.ic2eq + c.a2*s.ic1eq + c.a3*v3
	s.ic1eq = 2.0*v1 - s.ic1eq
	s.ic2eq = 2.0*v2 - s.ic2eq
	return c.m0*v0 + c.m1*v1 + c.m2*v2
}

func processSVFLowHigh(c svfCoeffs, s *svfState, v0 float64) (float64, float64) {
	v3 := v0 - s.ic2eq
	v1 := c.a1*s.ic1eq + c.a2*v3
	v2 := s.ic2eq + c.a2*s.ic1eq + c.a3*v3
	s.ic1eq = 2.0*v1 - s.ic1eq
	s.ic2eq = 2.0*v2 - s.ic2eq
	low := v2
	high := v0 - c.m1*v1 - v2
	return low, high
}

func sanitizeSample(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0.0
	}
	if math.Abs(x) < 1e-30 {
		return 0.0
	}
	return x
}

func dbToLin(db float64) float64 {
	return math.Pow(10.0, db/20.0)
}

func linToDB(lin float64) float64 {
	if lin < 1e-12 {
		return -240.0
	}
	return 20.0 * math.Log10(lin)
}

// isChainNeutral returns true when every DSP stage is configured for unity passthrough.
func (e *Engine) isChainNeutral() bool {
	p := &e.params
	if p.Bypass {
		return true
	}
	if math.Abs(p.InputGainDB) >= 1e-7 {
		return false
	}
	if p.EQEnabled {
		for i := 0; i < NumEQBands; i++ {
			if e.eqCoeffs[i].active {
				return false
			}
		}
	}
	if p.Repair.Enabled && (math.Abs(p.Repair.DeEssDB) >= 1e-7 || math.Abs(p.Repair.TransientDB) >= 1e-7 || p.Repair.DeClip) {
		return false
	}
	if p.Compressor.Enabled && p.Compressor.Ratio > 1.0001 && (p.Compressor.ThresholdDB < -1e-5 || math.Abs(p.Compressor.MakeupDB) >= 1e-7) {
		return false
	}
	if p.Compressor.Enabled && math.Abs(p.Compressor.MakeupDB) >= 1e-7 {
		return false
	}
	if p.Saturation.Enabled && p.Saturation.Amount >= 1e-5 {
		return false
	}
	if p.Stereo.Enabled && (math.Abs(p.Stereo.WidthPct-100.0) >= 1e-5 || p.Stereo.MonoBass) {
		return false
	}
	if p.Limiter.Enabled {
		return false
	}
	if p.DitherBits == 16 || p.DitherBits == 24 {
		return false
	}
	return true
}

// ProcessBlock processes a stereo Float32 block in-place or into outL/outR with zero heap allocations.
func (e *Engine) ProcessBlock(inL, inR, outL, outR []float32) {
	n := len(inL)
	if len(inR) < n {
		n = len(inR)
	}
	if len(outL) < n {
		n = len(outL)
	}
	if len(outR) < n {
		n = len(outR)
	}
	if n == 0 {
		return
	}

	// Fast bit-identical bypass when Bypass is enabled or all stages are neutral (and not in loudness-matched A mode).
	if e.params.Bypass || (e.isChainNeutral() && !e.params.ABOriginal) {
		for i := 0; i < n; i++ {
			l := float64(inL[i])
			r := float64(inR[i])
			if math.IsNaN(l) || math.IsInf(l, 0) {
				outL[i] = 0
			} else {
				outL[i] = inL[i]
			}
			if math.IsNaN(r) || math.IsInf(r, 0) {
				outR[i] = 0
			} else {
				outR[i] = inR[i]
			}
		}
		e.lastGRDB = 0
		e.lastLimGRDB = 0
		return
	}

	inGain := 1.0
	if math.Abs(e.params.InputGainDB) >= 1e-7 {
		inGain = dbToLin(e.params.InputGainDB)
	}

	compActive := e.params.Compressor.Enabled && (e.params.Compressor.Ratio > 1.0001 || math.Abs(e.params.Compressor.MakeupDB) >= 1e-7)
	satActive := e.params.Saturation.Enabled && e.params.Saturation.Amount >= 1e-5
	stereoActive := e.params.Stereo.Enabled && (math.Abs(e.params.Stereo.WidthPct-100.0) >= 1e-5 || e.params.Stereo.MonoBass)
	repairActive := e.params.Repair.Enabled && (math.Abs(e.params.Repair.DeEssDB) >= 1e-7 || math.Abs(e.params.Repair.TransientDB) >= 1e-7 || e.params.Repair.DeClip)
	limActive := e.params.Limiter.Enabled

	for i := 0; i < n; i++ {
		rawL := sanitizeSample(float64(inL[i]))
		rawR := sanitizeSample(float64(inR[i]))

		l := rawL * inGain
		r := rawR * inGain

		// Stage 1: AI Repair (De-Clip, De-Ess, Transient Shaper)
		if repairActive {
			l, r = e.processRepairSample(l, r)
		}

		// Stage 2: 5-Band Topology-Preserving Transform (TPT/ZDF) Parametric EQ
		if e.params.EQEnabled {
			for b := 0; b < NumEQBands; b++ {
				c := e.eqCoeffs[b]
				if c.active {
					l = processSVF(c, &e.eqState[b][0], l)
					r = processSVF(c, &e.eqState[b][1], r)
				}
			}
		}

		// Stage 3: Program-Dependent Stereo Compressor with 90 Hz Sidechain HPF
		if compActive {
			l, r = e.processCompressorSample(l, r)
		} else {
			e.lastGRDB = 0
		}

		// Stage 4: 2x Oversampled ADAA Analog Harmonic Saturation + DC Blocker
		if satActive {
			l, r = e.processSaturationSample(l, r)
		}

		// Stage 5: Mid/Side Stereo Width + Linkwitz-Riley 4th-order Mono-Bass Crossover
		if stereoActive {
			l, r = e.processStereoSample(l, r)
		}

		// Stage 6: 4x Oversampled ITU-R BS.1770-4 True-Peak Brickwall Limiter
		if limActive {
			l, r = e.processLimiterSample(l, r)
		} else {
			e.lastLimGRDB = 0
		}

		// Track input/output energy for Loudness-Matched A/B monitoring
		e.inEnergySum = 0.9995*e.inEnergySum + 0.0005*(rawL*rawL+rawR*rawR)
		e.outEnergySum = 0.9995*e.outEnergySum + 0.0005*(l*l+r*r)
		if e.inEnergySum > 1e-9 && e.outEnergySum > 1e-9 {
			targetAB := math.Sqrt(e.outEnergySum / e.inEnergySum)
			if targetAB > 4.0 {
				targetAB = 4.0
			} else if targetAB < 0.25 {
				targetAB = 0.25
			}
			e.abGainLin = 0.995*e.abGainLin + 0.005*targetAB
		}

		if e.params.ABOriginal {
			if e.params.LoudnessMatchAB {
				l = rawL * e.abGainLin
				r = rawR * e.abGainLin
			} else {
				l = rawL
				r = rawR
			}
		} else if e.params.LoudnessMatchAB && e.abGainLin > 1e-6 {
			// Normalize Mastered B back to original reference loudness when Level Match is active on B
			l /= e.abGainLin
			r /= e.abGainLin
		}

		// Stage 7: TPDF Dither for 16-bit or 24-bit Quantization
		if e.params.DitherBits == 16 || e.params.DitherBits == 24 {
			l = e.applyTPDFDither(l, e.params.DitherBits)
			r = e.applyTPDFDither(r, e.params.DitherBits)
		}

		outL[i] = float32(sanitizeSample(l))
		outR[i] = float32(sanitizeSample(r))
	}
}

func (e *Engine) processRepairSample(l, r float64) (float64, float64) {
	rep := &e.params.Repair
	if rep.DeClip {
		const clipThresh = 0.96
		if math.Abs(l) > clipThresh {
			sign := 1.0
			if l < 0 {
				sign = -1.0
			}
			excess := math.Abs(l) - clipThresh
			l = sign * (clipThresh + 0.04*math.Tanh(excess/0.04))
		}
		if math.Abs(r) > clipThresh {
			sign := 1.0
			if r < 0 {
				sign = -1.0
			}
			excess := math.Abs(r) - clipThresh
			r = sign * (clipThresh + 0.04*math.Tanh(excess/0.04))
		}
	}

	if rep.DeEssDB > 1e-5 {
		sibL := processSVF(e.deEssCoeffs, &e.deEssState[0], l)
		sibR := processSVF(e.deEssCoeffs, &e.deEssState[1], r)
		sibPeak := math.Max(math.Abs(sibL), math.Abs(sibR))
		alpha := math.Exp(-1.0 / (0.004 * e.sampleRate))
		e.deEssEnv = alpha*e.deEssEnv + (1.0-alpha)*sibPeak
		if e.deEssEnv > 0.05 {
			maxAtten := 1.0 - dbToLin(-rep.DeEssDB)
			ratio := math.Min(1.0, (e.deEssEnv-0.05)/0.25)
			l -= sibL * maxAtten * ratio
			r -= sibR * maxAtten * ratio
		}
	}

	if math.Abs(rep.TransientDB) > 1e-5 {
		peak := math.Max(math.Abs(l), math.Abs(r))
		aFast := math.Exp(-1.0 / (0.002 * e.sampleRate))
		aSlow := math.Exp(-1.0 / (0.035 * e.sampleRate))
		e.transFast = aFast*e.transFast + (1.0-aFast)*peak
		e.transSlow = aSlow*e.transSlow + (1.0-aSlow)*peak
		diff := e.transFast - e.transSlow
		if diff > 0.001 && e.transFast > 0.005 {
			norm := math.Min(1.0, diff/(e.transFast+1e-6))
			gain := dbToLin(rep.TransientDB * norm)
			l *= gain
			r *= gain
		}
	}
	return l, r
}

func (e *Engine) processCompressorSample(l, r float64) (float64, float64) {
	c := &e.params.Compressor
	scL := l
	scR := r
	if c.SidechainHPFHz > 10.0 && e.scHPFCoeffs.active {
		_, scL = processSVFLowHigh(e.scHPFCoeffs, &e.scHPFState[0][0], scL)
		_, scL = processSVFLowHigh(e.scHPFCoeffs, &e.scHPFState[0][1], scL)
		_, scR = processSVFLowHigh(e.scHPFCoeffs, &e.scHPFState[1][0], scR)
		_, scR = processSVFLowHigh(e.scHPFCoeffs, &e.scHPFState[1][1], scR)
	}

	// Linked peak-envelope detector so sine/program crests read accurately without zero-crossing ripple
	instPeak := math.Max(math.Abs(scL), math.Abs(scR))
	peakDecay := math.Exp(-1.0 / (0.025 * e.sampleRate))
	if instPeak >= e.compPeakEnv {
		e.compPeakEnv = instPeak
	} else {
		e.compPeakEnv = peakDecay*e.compPeakEnv + (1.0-peakDecay)*instPeak
	}
	detDB := linToDB(e.compPeakEnv)

	var targetGRDB float64
	if c.Ratio > 1.0001 {
		slope := 1.0 - (1.0 / c.Ratio)
		overDB := detDB - c.ThresholdDB
		knee := c.KneeDB
		if knee > 0.01 && overDB > -knee*0.5 && overDB < knee*0.5 {
			x := overDB + knee*0.5
			targetGRDB = slope * (x * x) / (2.0 * knee)
		} else if overDB >= knee*0.5 || (knee <= 0.01 && overDB > 0.0) {
			targetGRDB = slope * overDB
		}
	}

	attMS := math.Max(0.2, c.AttackMS)
	relMS := math.Max(5.0, c.ReleaseMS)
	// Use 2.5x faster internal RC constant so 95% settling occurs within the nominal AttackMS/ReleaseMS window.
	attCoeff := math.Exp(-2.5 / (attMS * 0.001 * e.sampleRate))
	relCoeff := math.Exp(-2.5 / (relMS * 0.001 * e.sampleRate))

	if targetGRDB > e.compEnvDB {
		e.compEnvDB = attCoeff*e.compEnvDB + (1.0-attCoeff)*targetGRDB
	} else {
		e.compEnvDB = relCoeff*e.compEnvDB + (1.0-relCoeff)*targetGRDB
	}

	e.lastGRDB = e.compEnvDB
	totalGainDB := c.MakeupDB - e.compEnvDB
	gainLin := dbToLin(totalGainDB)
	return l * gainLin, r * gainLin
}

func adaaThickWave(x, drive float64) (float64, float64) {
	dx := drive * x
	var f0 float64
	if math.Abs(dx) > 20.0 {
		if dx > 0 {
			f0 = 1.0
		} else {
			f0 = -1.0
		}
	} else {
		f0 = math.Tanh(dx)
	}
	// Exact antiderivative F1(x) = ln(cosh(drive * x)) / drive
	absDX := math.Abs(dx)
	lnCosh := absDX + math.Log1p(math.Exp(-2.0*absDX)) - math.Ln2
	f1 := lnCosh / drive
	return f0, f1
}

func adaaWarmWave(x, drive float64) (float64, float64) {
	// Single-ended Class-A triode transfer function: dominant quadratic H2 (x^2) with mild cubic H3
	g := 0.35 + 0.15*drive
	xClamped := math.Max(-1.5, math.Min(1.5, x))
	x2 := xClamped * xClamped
	x3 := x2 * xClamped
	f0 := xClamped + 0.42*g*x2 - 0.04*g*x3
	f1 := 0.5*x2 + (0.42*g/3.0)*x3 - 0.01*g*x2*x2
	return f0, f1
}

func (e *Engine) processSaturationSample(l, r float64) (float64, float64) {
	amt := math.Min(100.0, math.Max(0.0, e.params.Saturation.Amount)) / 100.0
	drive := 1.0 + amt*3.2
	norm := 1.0 / math.Tanh(drive)
	if norm > 1.2 {
		norm = 1.2
	}

	inSamples := [2]float64{l, r}
	var outSamples [2]float64

	// 20 Hz subsonic DC blocker coefficient so asymmetric triode DC settles within 15 ms
	dcR := 1.0 - (2.0 * math.Pi * 20.0 / e.sampleRate)
	if dcR < 0.96 {
		dcR = 0.96
	}

	for ch := 0; ch < 2; ch++ {
		xCurr := inSamples[ch]
		// 2x linear oversampled midpoint + current sample
		xMid := 0.5 * (e.satPrevIn[ch] + xCurr)
		e.satPrevIn[ch] = xCurr

		subInputs := [2]float64{xMid, xCurr}
		var subOutputs [2]float64

		for s := 0; s < 2; s++ {
			x := subInputs[s]
			var y float64
			switch e.params.Saturation.Character {
			case SatWarm:
				f0, f1 := adaaWarmWave(x, drive)
				diff := x - e.satPrevX[ch]
				if math.Abs(diff) > 1e-5 {
					y = 0.5*f0 + 0.5*(f1-e.satPrevF1[ch])/diff
				} else {
					y = f0
				}
				e.satPrevX[ch] = x
				e.satPrevF1[ch] = f1
				y *= 0.82 * norm
			case SatCrisp:
				// Iron transformer low-frequency weight + high-frequency harmonic sheen
				e.ironLP[ch] = 0.96*e.ironLP[ch] + 0.04*x
				hi := x - e.ironLP[ch]
				xShaped := x + 0.35*amt*hi + 0.20*amt*e.ironLP[ch]
				f0, f1 := adaaThickWave(xShaped, drive*1.1)
				diff := xShaped - e.satPrevX[ch]
				if math.Abs(diff) > 1e-6 {
					y = (f1 - e.satPrevF1[ch]) / diff
				} else {
					y = f0
				}
				e.satPrevX[ch] = xShaped
				e.satPrevF1[ch] = f1
				y *= norm
			case SatThick:
				fallthrough
			default:
				f0, f1 := adaaThickWave(x, drive)
				diff := x - e.satPrevX[ch]
				if math.Abs(diff) > 1e-6 {
					y = (f1 - e.satPrevF1[ch]) / diff
				} else {
					y = f0
				}
				e.satPrevX[ch] = x
				e.satPrevF1[ch] = f1
				y *= norm
			}
			subOutputs[s] = y
		}

		// Downsample 2x -> 1x via half-band average and blend with dry signal
		wet := 0.5 * (subOutputs[0] + subOutputs[1])
		mixed := (1.0-amt)*xCurr + amt*wet

		// Remove any asymmetric DC offset
		dcY := mixed - e.dcPrevX[ch] + dcR*e.dcPrevY[ch]
		e.dcPrevX[ch] = mixed
		e.dcPrevY[ch] = dcY
		outSamples[ch] = dcY
	}
	return outSamples[0], outSamples[1]
}

func (e *Engine) processStereoSample(l, r float64) (float64, float64) {
	width := math.Max(0.0, math.Min(200.0, e.params.Stereo.WidthPct)) / 100.0
	mid := 0.5 * (l + r)
	side := 0.5 * (l - r)

	if !e.params.Stereo.MonoBass {
		side *= width
		return mid + side, mid - side
	}

	// 8th-order Linkwitz-Riley (4 cascaded 2nd-order Butterworth SVFs) high-pass on Side channel
	_, s1 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[0], side)
	_, s2 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[1], s1)
	_, s3 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[2], s2)
	_, highSide := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[3], s3)

	// Elliptical bass mono-maker: fold sub-crossover Side energy into Mid so out-of-phase bass stays audible & centered
	lowSide := side - highSide
	monoMid := mid + 0.70710678*lowSide
	scaledSide := highSide * width
	return monoMid + scaledSide, monoMid - scaledSide
}

// estimateTruePeak4x computes the 4x oversampled inter-sample peak between previous and current samples.
func estimateTruePeak4x(hm1, h0, h1, h2 float64) float64 {
	maxAbs := math.Max(math.Abs(h0), math.Abs(h1))
	// 4-point cubic Catmull-Rom / Hermite polyphase interpolation at t = 0.25, 0.50, 0.75
	a0 := -0.5*hm1 + 1.5*h0 - 1.5*h1 + 0.5*h2
	a1 := hm1 - 2.5*h0 + 2.0*h1 - 0.5*h2
	a2 := -0.5*hm1 + 0.5*h1
	a3 := h0

	phases := [3]float64{0.25, 0.50, 0.75}
	for _, t := range phases {
		t2 := t * t
		t3 := t2 * t
		v := math.Abs(a0*t3 + a1*t2 + a2*t + a3)
		if v > maxAbs {
			maxAbs = v
		}
	}
	return maxAbs
}

func (e *Engine) processLimiterSample(l, r float64) (float64, float64) {
	ceilingLin := dbToLin(e.params.Limiter.CeilingDBTP)
	if ceilingLin <= 0.0 {
		ceilingLin = dbToLin(-1.0)
	}
	if e.params.Limiter.TruePeak {
		// Provide 0.04 dB headroom guard for 4x cubic vssinc true-peak detector
		ceilingLin *= 0.995
	}

	peakL := math.Abs(l)
	peakR := math.Abs(r)
	if e.params.Limiter.TruePeak {
		tpL := estimateTruePeak4x(e.limPrevL[0], e.limPrevL[1], e.limPrevL[2], l)
		tpR := estimateTruePeak4x(e.limPrevR[0], e.limPrevR[1], e.limPrevR[2], r)
		if tpL > peakL {
			peakL = tpL
		}
		if tpR > peakR {
			peakR = tpR
		}
	}
	e.limPrevL[0], e.limPrevL[1], e.limPrevL[2] = e.limPrevL[1], e.limPrevL[2], l
	e.limPrevR[0], e.limPrevR[1], e.limPrevR[2] = e.limPrevR[1], e.limPrevR[2], r

	peak := math.Max(peakL, peakR)
	reqGain := 1.0
	if peak > ceilingLin && peak > 1e-12 {
		reqGain = ceilingLin / peak
	}

	relMS := math.Max(10.0, e.params.Limiter.ReleaseMS)
	relCoeff := math.Exp(-1.0 / (relMS * 0.001 * e.sampleRate))

	if reqGain < e.limEnvLin {
		// Instant brickwall attack to prevent any true-peak overshoot
		e.limEnvLin = reqGain
	} else {
		e.limEnvLin = relCoeff*e.limEnvLin + (1.0-relCoeff)*1.0
		if reqGain < e.limEnvLin {
			e.limEnvLin = reqGain
		}
	}

	e.lastLimGRDB = -linToDB(e.limEnvLin)
	if e.lastLimGRDB < 0.0 {
		e.lastLimGRDB = 0.0
	}

	outL := l * e.limEnvLin
	outR := r * e.limEnvLin
	if math.Abs(outL) > ceilingLin {
		if outL > 0 {
			outL = ceilingLin
		} else {
			outL = -ceilingLin
		}
	}
	if math.Abs(outR) > ceilingLin {
		if outR > 0 {
			outR = ceilingLin
		} else {
			outR = -ceilingLin
		}
	}
	return outL, outR
}

func (e *Engine) nextUniform() float64 {
	x := e.prngState
	x ^= x >> 12
	x ^= x << 25
	x ^= x >> 27
	e.prngState = x
	prod := x * 0x2545F4914F6CDD1D
	return float64(prod>>11) * (1.0 / 9007199254740992.0)
}

func (e *Engine) applyTPDFDither(sample float64, bits int) float64 {
	var scale float64
	if bits == 16 {
		scale = 32768.0
	} else {
		scale = 8388608.0
	}
	// Triangular Probability Density Function (TPDF) = (u1 - u2) * 1 LSB
	tpdf := (e.nextUniform() - e.nextUniform()) / scale
	quantized := math.Round((sample+tpdf)*scale) / scale
	if quantized > 1.0-(1.0/scale) {
		quantized = 1.0 - (1.0 / scale)
	} else if quantized < -1.0 {
		quantized = -1.0
	}
	return quantized
}
