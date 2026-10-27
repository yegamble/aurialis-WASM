// Package dsp implements a digital zero-allocation mastering DSP engine
// shared between the native Go server and the browser WebAssembly module.
package dsp

import (
	"math"
)

// FilterType identifies the topology of a parametric EQ band.
type FilterType string

const (
	// FilterHighPass is a second-order TPT high-pass filter.
	FilterHighPass FilterType = "high_pass"
	// FilterLowShelf is a resonant TPT low-shelf filter.
	FilterLowShelf FilterType = "low_shelf"
	// FilterPeaking is a proportional-Q TPT bell/peaking filter.
	FilterPeaking FilterType = "peaking"
	// FilterHighShelf is a resonant TPT high-shelf filter.
	FilterHighShelf FilterType = "high_shelf"
)

// SatCharacter identifies a heuristic harmonic transfer shape.
type SatCharacter string

// Original coloration models; legacy character names retain their prior curves.
const (
	SatClean       SatCharacter = "Clean"
	SatTube        SatCharacter = "Tube"
	SatTape        SatCharacter = "Tape"
	SatTransformer SatCharacter = "Transformer"
)

const (
	// SatWarm selects an asymmetric polynomial with even-order harmonics.
	SatWarm SatCharacter = "Warm"
	// SatThick selects symmetric tanh saturation with odd-order harmonics.
	SatThick SatCharacter = "Thick"
	// SatCrisp selects frequency-weighted tanh saturation.
	SatCrisp SatCharacter = "Crisp"
)

// CompTopology selects the compressor's detector, transfer curve and
// program-dependent release (see compressor_models.go).
type CompTopology string

const (
	// CompOptical is two-stage, exposure-dependent optical-style release.
	CompOptical CompTopology = "optical"
	// CompVariableMu is averaged sensing with a progressive ratio.
	CompVariableMu CompTopology = "vari_mu"
	// CompFET is fast peak sensing for transient control.
	CompFET CompTopology = "fet"
	// CompVCA is RMS sensing with crest-dependent auto release.
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
	AutoRelease    bool         `json:"autoRelease"`
	SidechainHPFHz float64      `json:"sidechainHpfHz"`
	Topology       CompTopology `json:"topology"`
}

// SaturationParams configures the 2x oversampled ADAA harmonic saturator.
type SaturationParams struct {
	Enabled   bool         `json:"enabled"`
	Amount    float64      `json:"amount"`
	Character SatCharacter `json:"character"`
}

// StereoParams configures mid/side width and cascaded side high-pass bass narrowing.
type StereoParams struct {
	Enabled     bool    `json:"enabled"`
	WidthPct    float64 `json:"widthPct"`
	MonoBass    bool    `json:"monoBass"`
	MidGainDB   float64 `json:"midGainDb"`
	SideGainDB  float64 `json:"sideGainDb"`
	CrossoverHz float64 `json:"crossoverHz"`
}

// LimiterParams configures a sample-peak limiter with an optional cubic
// inter-sample estimate. Legacy DBTP field names do not imply ITU compliance.
type LimiterParams struct {
	Enabled     bool    `json:"enabled"`
	CeilingDBTP float64 `json:"ceilingDbtp"`
	TargetLUFS  float64 `json:"targetLufs"` // Legacy metadata; no implicit loudness normalization.
	ReleaseMS   float64 `json:"releaseMs"`
	TruePeak    bool    `json:"truePeak"`
}

// RepairParams configures spectral sibilance control, transient shaping, and
// soft peak conditioning. DeClip softens peaks; it cannot reconstruct clipped audio.
type RepairParams struct {
	Enabled     bool    `json:"enabled"`
	DeEssDB     float64 `json:"deEssDb"`
	TransientDB float64 `json:"transientDb"`
	DeClip      bool    `json:"deClip"`
}

// Params holds the complete, orthogonal parameter state for the mastering chain.
type Params struct {
	// Omitted/zero retains the original algorithm. Version 2 is not implemented.
	AlgorithmVersion uint32                 `json:"algorithmVersion,omitempty"`
	Bypass           bool                   `json:"bypass"`
	ABOriginal       bool                   `json:"abOriginal"`
	LoudnessMatchAB  bool                   `json:"loudnessMatchAb"`
	InputGainDB      float64                `json:"inputGainDb"`
	EQEnabled        bool                   `json:"eqEnabled"`
	Bands            [NumEQBands]BandParams `json:"bands"`
	Compressor       CompressorParams       `json:"compressor"`
	Saturation       SaturationParams       `json:"saturation"`
	Stereo           StereoParams           `json:"stereo"`
	Limiter          LimiterParams          `json:"limiter"`
	Repair           RepairParams           `json:"repair"`
	DeHarsh          DeHarshParams          `json:"deHarsh"`
	Multiband        MultibandParams        `json:"multiband"`
	DitherBits       int                    `json:"ditherBits"`
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

// stageCoeffs contains only settings/sample-rate-derived values. Keeping them
// outside sample loops preserves the exact formulas without repeating expensive
// transcendental functions at the audio sample rate.
type stageCoeffs struct {
	compAttack, compRelease                              float64
	compModel                                            compModelCoeffs
	satAmount, satDrive, satDCR, satMakeup               float64
	stereoWidth                                          float64
	limiterCeiling, limiterRelease, limiterSampleCeiling float64
	repairDeEssAlpha, repairDeEssMaxAtten                float64
	repairTransientFast, repairTransientSlow             float64
}

// Engine executes the real-time and offline mastering DSP chain with zero heap allocations per block.
type Engine struct {
	extended   extendedState
	sampleRate float64
	params     Params
	stages     stageCoeffs

	eqCoeffs [NumEQBands]svfCoeffs
	eqState  [NumEQBands][2]svfState

	// Sidechain HPF (2 cascaded 2nd-order Butterworth SVFs = 24 dB/oct)
	scHPFCoeffs svfCoeffs
	scHPFState  [2][2]svfState
	compModel   compModelState
	compEnvDB   float64
	lastGRDB    float64

	// Saturation ADAA & DC blocker state
	satPrevX  [2]float64
	satPrevF1 [2]float64
	satPrevIn [2]float64
	dcPrevX   [2]float64
	dcPrevY   [2]float64
	ironLP    [2]float64
	ironHP    [2]float64

	// Stereo eighth-order side high-pass state (heuristic bass narrowing).
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
	truePeak    truePeakLimiter

	// Loudness-matched A/B tracking
	inEnergySum  float64
	outEnergySum float64
	abGainLin    float64

	// Deterministic xorshift64* state for TPDF dither
	prngState uint64

	// Per-sample gain reduction statistics (see GainReductionStats).
	grStats grStatsState
}

// NewEngine constructs and pre-allocates a mastering DSP engine for the given sample rate.
func NewEngine(sampleRate float64) *Engine {
	if !finite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0 {
		sampleRate = 48000.0
	}
	e := &Engine{
		sampleRate: sampleRate,
		params:     DefaultParams(),
		limEnvLin:  1.0,
		abGainLin:  1.0,
		prngState:  0x9E3779B97F4A7C15,
		truePeak:   newTruePeakLimiter(sampleRate),
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

// SetParams preserves running-stage histories and clears delay samples when a
// stage stops. It recomputes only coefficients whose parameters actually changed.
// Invalid updates are ignored atomically; call ValidateParams to obtain an error.
func (e *Engine) SetParams(next Params) {
	if ValidateParams(next) != nil {
		return
	}
	prev := e.params
	e.params = next
	if algorithmOf(prev) != algorithmOf(next) {
		// Latency changes with the algorithm; never mix delayed and immediate frames.
		e.truePeak.reset()
	}
	if prev.Compressor != next.Compressor || prev.Saturation != next.Saturation || prev.Stereo != next.Stereo || prev.Limiter != next.Limiter || prev.Repair != next.Repair || prev.DeHarsh != next.DeHarsh || prev.Multiband != next.Multiband {
		e.recomputeStageCoeffs()
	}
	if prev.Saturation != next.Saturation {
		e.rebaseSaturation()
	}
	for i := 0; i < NumEQBands; i++ {
		if prev.Bands[i] != next.Bands[i] {
			wasActive := e.eqCoeffs[i].active
			e.eqCoeffs[i] = computeBandCoeffs(e.sampleRate, next.Bands[i])
			if wasActive && !e.eqCoeffs[i].active {
				e.eqState[i] = [2]svfState{}
			}
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
	e.clearStoppedStageHistory(prev)
}

// SetBand updates exclusively EQ band index [0..4] without touching any other band or module.
// Invalid bands are ignored atomically.
func (e *Engine) SetBand(index int, band BandParams) {
	if index < 0 || index >= NumEQBands {
		return
	}
	candidate := e.params
	candidate.Bands[index] = band
	if ValidateParams(candidate) != nil {
		return
	}
	if e.params.Bands[index] == band {
		return
	}
	e.params.Bands[index] = band
	wasActive := e.eqCoeffs[index].active
	e.eqCoeffs[index] = computeBandCoeffs(e.sampleRate, band)
	if wasActive && !e.eqCoeffs[index].active {
		e.eqState[index] = [2]svfState{}
	}
}

// Reset clears filter delay lines and envelope followers back to zero silence.
func (e *Engine) Reset() {
	e.extended = extendedState{}
	e.recomputeExtended()
	e.eqState = [NumEQBands][2]svfState{}
	e.scHPFState = [2][2]svfState{}
	e.compModel = compModelState{}
	e.compEnvDB = 0.0
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
	e.truePeak.reset()
	e.inEnergySum = 0.0
	e.outEnergySum = 0.0
	e.abGainLin = 1.0
	e.prngState = 0x9E3779B97F4A7C15
	e.grStats = grStatsState{}
}

// LastGainReductionDB returns the most recent combined compressor + limiter gain reduction in dB.
func (e *Engine) LastGainReductionDB() float64 {
	return e.lastGRDB + e.lastLimGRDB
}

func (e *Engine) recomputeStageCoeffs() {
	e.recomputeExtended()
	c := &e.params.Compressor
	e.stages.compModel = prepareCompModel(e.sampleRate, c.Topology)
	attMS := math.Max(0.02, c.AttackMS)
	relMS := math.Max(5.0, c.ReleaseMS)
	e.stages.compAttack = math.Exp(-2.5 / (attMS * 0.001 * e.sampleRate))
	e.stages.compRelease = math.Exp(-2.5 / (relMS * 0.001 * e.sampleRate))

	e.stages.satAmount = math.Min(100.0, math.Max(0.0, e.params.Saturation.Amount)) / 100.0
	e.stages.satDrive = 1.0 + e.stages.satAmount*3.2
	e.stages.satMakeup = saturationMakeup(e.params.Saturation.Character, e.stages.satAmount, e.stages.satDrive)
	e.stages.satDCR = 1.0 - (2.0 * math.Pi * 20.0 / e.sampleRate)
	if e.stages.satDCR < 0.96 {
		e.stages.satDCR = 0.96
	}
	e.stages.stereoWidth = math.Max(0.0, math.Min(200.0, e.params.Stereo.WidthPct)) / 100.0

	ceilingLin := dbToLin(e.params.Limiter.CeilingDBTP)
	if ceilingLin <= 0.0 {
		ceilingLin = dbToLin(-1.0)
	}
	if e.params.Limiter.TruePeak {
		ceilingLin *= 0.995
	}
	e.stages.limiterCeiling = ceilingLin
	limRelMS := math.Max(10.0, e.params.Limiter.ReleaseMS)
	e.stages.limiterRelease = math.Exp(-1.0 / (limRelMS * 0.001 * e.sampleRate))
	ceiling64 := dbToLin(e.params.Limiter.CeilingDBTP)
	ceiling32 := float32(ceiling64)
	if float64(ceiling32) > ceiling64 {
		ceiling32 = math.Nextafter32(ceiling32, 0)
	}
	e.stages.limiterSampleCeiling = float64(ceiling32)

	e.stages.repairDeEssAlpha = math.Exp(-1.0 / (0.004 * e.sampleRate))
	e.stages.repairDeEssMaxAtten = 1.0 - dbToLin(-e.params.Repair.DeEssDB)
	e.stages.repairTransientFast = math.Exp(-1.0 / (0.002 * e.sampleRate))
	e.stages.repairTransientSlow = math.Exp(-1.0 / (0.035 * e.sampleRate))
}

func (e *Engine) recomputeAllCoeffs() {
	e.recomputeStageCoeffs()
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
	if !b.Enabled || (b.Type != FilterHighPass && math.Abs(b.GainDB) < 1e-7) {
		return svfCoeffs{active: false}
	}
	q := b.Q
	if q < 0.1 {
		q = 0.707
	}
	amp := math.Pow(10.0, b.GainDB/40.0)
	switch b.Type {
	case FilterHighPass:
		g := math.Tan(math.Pi * clampFreq(sampleRate, b.FreqHz) / sampleRate)
		k := 1 / q
		a1 := 1 / (1 + g*(g+k))
		return svfCoeffs{a1: a1, a2: g * a1, a3: g * g * a1, m0: 1, m1: -k, m2: -1, active: true}
	case FilterLowShelf:
		// Legacy corner scaling with Q-controlled shelf damping.
		fc := clampFreq(sampleRate, b.FreqHz*1.85)
		g := math.Tan(math.Pi*fc/sampleRate) / math.Sqrt(amp)
		k := 1.22 * 0.707 / q
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
		// Legacy corner scaling with Q-controlled shelf damping.
		fc := clampFreq(sampleRate, b.FreqHz/1.54)
		g := math.Tan(math.Pi*fc/sampleRate) * math.Sqrt(amp)
		k := 1.23 * 0.707 / q
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
		// Gain-dependent Q narrows skirts as gain increases.
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
	s.ic1eq = sanitizeSample(2.0*v1 - s.ic1eq)
	s.ic2eq = sanitizeSample(2.0*v2 - s.ic2eq)
	return c.m0*v0 + c.m1*v1 + c.m2*v2
}

func processSVFLowHigh(c svfCoeffs, s *svfState, v0 float64) (float64, float64) {
	v3 := v0 - s.ic2eq
	v1 := c.a1*s.ic1eq + c.a2*v3
	v2 := s.ic2eq + c.a2*s.ic1eq + c.a3*v3
	s.ic1eq = sanitizeSample(2.0*v1 - s.ic1eq)
	s.ic2eq = sanitizeSample(2.0*v2 - s.ic2eq)
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

// finiteFloat32 also checks after narrowing: finite float64 values can overflow float32.
func finiteFloat32(x float64) float32 {
	x = sanitizeSample(x)
	if x > math.MaxFloat32 {
		return math.MaxFloat32
	}
	if x < -math.MaxFloat32 {
		return -math.MaxFloat32
	}
	return float32(x)
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
	if p.Compressor.Enabled && p.Compressor.Ratio > 1.0001 {
		return false
	}
	if p.Compressor.Enabled && math.Abs(p.Compressor.MakeupDB) >= 1e-7 {
		return false
	}
	if p.Saturation.Enabled && p.Saturation.Amount >= 1e-5 && p.Saturation.Character != SatClean {
		return false
	}
	if p.Stereo.Enabled && (math.Abs(p.Stereo.WidthPct-100.0) >= 1e-5 || p.Stereo.MonoBass || p.Stereo.MidGainDB != 0 || p.Stereo.SideGainDB != 0 || math.Abs(e.extended.currentMid-e.extended.midGain) > 1e-7 || math.Abs(e.extended.currentSide-e.extended.sideGain) > 1e-7) {
		return false
	}
	if p.DeHarsh.Enabled || p.Multiband.Enabled {
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
	e.processBlock(inL, inR, outL, outR, nil)
}

func (e *Engine) processBlock(inL, inR, outL, outR []float32, lanes *automationLanes) {
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
	laneActive := lanes != nil && (len(lanes.gain) > 0 || (e.params.Stereo.Enabled && len(lanes.width) > 0))
	if e.params.Bypass || (!laneActive && e.isChainNeutral() && !e.params.ABOriginal) {
		if e.params.AlgorithmVersion == TruePeakAlgorithmVersion {
			for i := 0; i < n; i++ {
				outL[i], outR[i] = e.truePeakPassthrough(inL[i], inR[i])
			}
			e.truePeak.pending = e.truePeak.latency
			e.lastGRDB = 0
			e.lastLimGRDB = 0
			return
		}
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
	satActive := e.params.Saturation.Enabled && e.params.Saturation.Amount >= 1e-5 && e.params.Saturation.Character != SatClean
	stereoActive := e.params.Stereo.Enabled && ((lanes != nil && len(lanes.width) > 0) || math.Abs(e.params.Stereo.WidthPct-100.0) >= 1e-5 || e.params.Stereo.MonoBass || e.params.Stereo.MidGainDB != 0 || e.params.Stereo.SideGainDB != 0 || math.Abs(e.extended.currentMid-e.extended.midGain) > 1e-7 || math.Abs(e.extended.currentSide-e.extended.sideGain) > 1e-7)
	repairActive := e.params.Repair.Enabled && (math.Abs(e.params.Repair.DeEssDB) >= 1e-7 || math.Abs(e.params.Repair.TransientDB) >= 1e-7 || e.params.Repair.DeClip)
	limActive := e.params.Limiter.Enabled
	truePeakV2 := e.params.AlgorithmVersion == TruePeakAlgorithmVersion

	for i := 0; i < n; i++ {
		rawL := sanitizeSample(float64(inL[i]))
		rawR := sanitizeSample(float64(inR[i]))

		frameGain := inGain
		if lanes != nil && len(lanes.gain) > 0 {
			frameGain = 1
			if math.Abs(lanes.gain[i]) >= 1e-7 {
				frameGain = dbToLin(lanes.gain[i])
			}
		}
		l := rawL * frameGain
		r := rawR * frameGain

		// Stage 1: Deterministic soft clipping, de-essing, and transient shaping
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

		if e.params.DeHarsh.Enabled {
			l, r = e.processDeHarsh(l, r)
		}
		if e.params.Multiband.Enabled {
			l, r = e.processMultiband(l, r)
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

		// Stage 5: Mid/Side Stereo Width + cascaded Side high-pass bass narrowing
		if stereoActive {
			if lanes != nil && len(lanes.width) > 0 {
				width := lanes.width[i] / 100
				neutral := width == 1 && !e.params.Stereo.MonoBass && e.extended.midGain == 1 && e.extended.sideGain == 1 && e.extended.currentMid == 1 && e.extended.currentSide == 1
				if !neutral {
					l, r = e.processStereoSampleWidth(l, r, width)
				}
			} else {
				l, r = e.processStereoSample(l, r)
			}
		}

		// Stage 6: v1 sample-peak limiter with optional cubic inter-sample estimate,
		// or the v2 lookahead limiter against reconstructed (true) peaks.
		switch {
		case truePeakV2:
			l, r, rawL, rawR = e.processTruePeakStage(l, r, rawL, rawR, limActive)
		case limActive:
			l, r = e.processLimiterSample(l, r)
		default:
			e.lastLimGRDB = 0
		}
		outL[i], outR[i] = e.finishSample(l, r, rawL, rawR, limActive)
		e.grStats.observe(compActive, e.compModel.level, e.lastGRDB, e.lastLimGRDB)
	}
	if truePeakV2 {
		e.truePeak.pending = e.truePeak.latency
	}
}

// finishSample applies loudness-matched monitoring, dither, and the final
// linked sample ceiling after the limiter stage.
func (e *Engine) finishSample(l, r, rawL, rawR float64, limActive bool) (float32, float32) {
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

	// Monitor level matching and dither occur after the main limiter. Reapply
	// a linked sample ceiling to mastered B so those stages cannot exceed it.
	// Original A and explicit bypass retain the unprocessed source.
	if limActive && !e.params.ABOriginal {
		ceiling := e.stages.limiterSampleCeiling
		peak := math.Max(math.Abs(l), math.Abs(r))
		if peak > ceiling {
			multiplier := ceiling / peak
			l *= multiplier
			r *= multiplier
			e.lastLimGRDB -= linToDB(multiplier)
			// Keep dithered output on its quantization grid; truncation toward
			// zero cannot exceed the ceiling.
			if scale := ditherScale(e.params.DitherBits); scale > 0 {
				l = math.Trunc(l*scale) / scale
				r = math.Trunc(r*scale) / scale
			}
		}
	}
	return finiteFloat32(l), finiteFloat32(r)
}

// deEssBandNorm normalizes the de-esser's Q=2 band-pass to unity gain at its center.
const deEssBandNorm = 0.5

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
		alpha := e.stages.repairDeEssAlpha
		e.deEssEnv = alpha*e.deEssEnv + (1.0-alpha)*sibPeak
		if e.deEssEnv > 0.05 {
			maxAtten := e.stages.repairDeEssMaxAtten
			ratio := math.Min(1.0, (e.deEssEnv-0.05)/0.25)
			// The Q=2 band output has gain 2 at 6.5 kHz. Subtract it at unity
			// so the cut never exceeds deEssDb and never inverts the band.
			cut := deEssBandNorm * maxAtten * ratio
			l -= sibL * cut
			r -= sibR * cut
		}
	}

	if math.Abs(rep.TransientDB) > 1e-5 {
		peak := math.Max(math.Abs(l), math.Abs(r))
		aFast := e.stages.repairTransientFast
		aSlow := e.stages.repairTransientSlow
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

	// Attack/release specify 91.8% gain-reduction settling (1-exp(-2.5)).
	// The topology model picks the detector and any program-dependent release.
	targetGRDB, relCoeff := e.compModel.target(scL, scR, c, &e.stages.compModel, e.stages.compRelease, e.compEnvDB)
	if targetGRDB > e.compEnvDB {
		e.compEnvDB = e.stages.compAttack*e.compEnvDB + (1.0-e.stages.compAttack)*targetGRDB
	} else {
		e.compEnvDB = relCoeff*e.compEnvDB + (1.0-relCoeff)*targetGRDB
	}
	grDB := e.compEnvDB
	if c.Topology == CompOptical {
		grDB = e.compModel.opticalSlowStage(targetGRDB, grDB, &e.stages.compModel)
	}

	e.lastGRDB = grDB
	totalGainDB := c.MakeupDB - grDB
	gainLin := dbToLin(totalGainDB)
	return l * gainLin, r * gainLin
}

func adaaThickValue(x, drive float64) float64 {
	dx := drive * x
	if math.Abs(dx) > 20.0 {
		if dx > 0 {
			return 1.0
		}
		return -1.0
	}
	return math.Tanh(dx)
}

func adaaThickIntegral(x, drive float64) float64 {
	dx := drive * x
	// Exact antiderivative F1(x) = ln(cosh(drive * x)) / drive.
	absDX := math.Abs(dx)
	lnCosh := absDX + math.Log1p(math.Exp(-2.0*absDX)) - math.Ln2
	return lnCosh / drive
}

func adaaWarmWave(x, drive float64) (float64, float64) {
	// Heuristic asymmetric polynomial: quadratic H2 with mild cubic H3.
	g := 0.35 + 0.15*drive
	xClamped := math.Max(-1.5, math.Min(1.5, x))
	x2 := xClamped * xClamped
	x3 := x2 * xClamped
	f0 := xClamped + 0.42*g*x2 - 0.04*g*x3
	f1 := 0.5*x2 + (0.42*g/3.0)*x3 - 0.01*g*x2*x2
	// Outside the polynomial interval f0 is constant, so its antiderivative
	// continues linearly. Clamping F1 would incorrectly halve changing hot inputs.
	f1 += f0 * (x - xClamped)
	return f0, f1
}

// saturationWet combines two 2x sub-steps of first-order ADAA output into a
// unity-small-signal wet sample. ADAA delays its linear response by half a
// sub-step, which dulled highs when blended with the dry path. Adding back the
// difference between the aligned input and that delayed linear response keeps
// the low-level response flat:
//
//	wet = (adaa0 + adaa1) / (2·slope) + (x1 − x0)/2 + (x1 − prev)/4
//
// The correction is linear, so it adds no aliasing; it lets steep (high-
// frequency) edges through at their unsaturated slope, making the curve's
// softening frequency-dependent rather than a hard peak bound. Input
// differences are written explicitly so large values never cancel against
// themselves, and explicit conversions prevent fused multiply-adds, keeping
// native and WebAssembly output bit-identical.
// saturationReference is the peak level (-12 dBFS) at which each curve keeps
// unity fundamental gain. Program material near that level keeps its loudness
// as drive rises; quieter signals gain at most a few dB and louder peaks soften.
const saturationReference = 0.25

// saturationMakeup is the wet gain that restores unity fundamental gain at
// saturationReference for a unity-slope curve. Warm's odd part is nearly
// linear there, so it keeps unity small-signal gain.
func saturationMakeup(character SatCharacter, amount, drive float64) float64 {
	// math.Tanh may round differently by one ulp where amd64 math assembly
	// uses FMA. Quantizing to 2^-20 keeps native and WebAssembly gains equal.
	odd := func(f func(float64) float64) float64 {
		g := saturationReference / (0.5 * (f(saturationReference) - f(-saturationReference)))
		return math.Round(g*(1<<20)) / (1 << 20)
	}
	tanhCurve := func(d, bias float64) func(float64) float64 {
		b := math.Tanh(bias)
		return func(x float64) float64 { return (math.Tanh(d*x+bias) - b) / (d * (1 - b*b)) }
	}
	switch character {
	case SatThick:
		return odd(tanhCurve(drive, 0))
	case SatCrisp:
		return odd(tanhCurve(drive*1.1, 0))
	case SatTube:
		return odd(tanhCurve(1+3*amount, .12))
	case SatTape, SatTransformer:
		return odd(tanhCurve(1+3*amount, 0))
	case SatWarm, SatClean:
		return 1
	default:
		return 1
	}
}

func saturationWet(adaa0, adaa1, slope, prev, x0, x1 float64) float64 {
	nonlinear := float64(0.5*adaa0)/slope + float64(0.5*adaa1)/slope
	return nonlinear + float64(0.5*(x1-x0)) + float64(0.25*(x1-prev))
}

func (e *Engine) processSaturationSample(l, r float64) (float64, float64) {
	if e.params.Saturation.Character == SatTube || e.params.Saturation.Character == SatTape || e.params.Saturation.Character == SatTransformer {
		return e.processNewSaturation(l, r)
	}
	amt := e.stages.satAmount
	drive := e.stages.satDrive

	inSamples := [2]float64{l, r}
	var outSamples [2]float64

	// 20 Hz subsonic DC blocker coefficient so asymmetric triode DC settles within 15 ms
	dcR := e.stages.satDCR

	for ch := 0; ch < 2; ch++ {
		xCurr := inSamples[ch]
		// 2x linear oversampled midpoint + current sample
		xMid := 0.5 * (e.satPrevIn[ch] + xCurr)
		e.satPrevIn[ch] = xCurr

		subInputs := [2]float64{xMid, xCurr}
		var adaa, shaped [2]float64
		var slope float64
		prev := e.satPrevX[ch]

		for s := 0; s < 2; s++ {
			x := subInputs[s]
			prevX := e.satPrevX[ch]
			shaped[s] = x
			var f1 float64
			switch e.params.Saturation.Character {
			case SatWarm:
				var f0 float64
				f0, f1 = adaaWarmWave(x, drive)
				adaa[s], slope = f0, 1
				if diff := x - prevX; math.Abs(diff) > 1e-5 {
					adaa[s] = (f1 - e.satPrevF1[ch]) / diff
				}
			case SatCrisp:
				// Iron transformer low-frequency weight + high-frequency harmonic sheen
				// Explicit conversions keep these linear tone terms FMA-free.
				e.ironLP[ch] = float64(0.96*e.ironLP[ch]) + float64(0.04*x)
				hi := x - e.ironLP[ch]
				shaped[s] = (x + float64(0.35*amt*hi)) + float64(0.20*amt*e.ironLP[ch])
				slope = drive * 1.1
				f1 = adaaThickIntegral(shaped[s], slope)
				if diff := shaped[s] - prevX; math.Abs(diff) > 1e-6 {
					adaa[s] = (f1 - e.satPrevF1[ch]) / diff
				} else {
					adaa[s] = adaaThickValue(shaped[s], slope)
				}
			case SatClean, SatTube, SatTape, SatTransformer:
				// New models are dispatched before this legacy loop.
				adaa[s], slope, f1 = 0.5*(x+prevX), 1, e.satPrevF1[ch]
			case SatThick:
				fallthrough
			default:
				slope = drive
				f1 = adaaThickIntegral(x, drive)
				if diff := x - prevX; math.Abs(diff) > 1e-6 {
					adaa[s] = (f1 - e.satPrevF1[ch]) / diff
				} else {
					adaa[s] = adaaThickValue(x, drive)
				}
			}
			e.satPrevX[ch] = shaped[s]
			e.satPrevF1[ch] = f1
		}

		// Unity fundamental gain at -12 dBFS peaks (see saturationReference):
		// drive adds harmonics and softens louder peaks without a level jump.
		// Two-point averaging decimates only the harmonic residual; it is not a
		// designed half-band filter.
		wet := float64(e.stages.satMakeup * saturationWet(adaa[0], adaa[1], slope, prev, shaped[0], shaped[1]))
		mixed := float64((1.0-amt)*xCurr) + float64(amt*wet)

		// Remove any asymmetric DC offset
		dcY := (mixed - e.dcPrevX[ch]) + float64(dcR*e.dcPrevY[ch])
		e.dcPrevX[ch] = mixed
		e.dcPrevY[ch] = dcY
		outSamples[ch] = dcY
	}
	return outSamples[0], outSamples[1]
}

func (e *Engine) processStereoSample(l, r float64) (float64, float64) {
	return e.processStereoSampleWidth(l, r, e.stages.stereoWidth)
}

func (e *Engine) processStereoSampleWidth(l, r, width float64) (float64, float64) {
	smooth := e.extended.gainSmooth
	e.extended.currentMid = smooth*e.extended.currentMid + (1-smooth)*e.extended.midGain
	e.extended.currentSide = smooth*e.extended.currentSide + (1-smooth)*e.extended.sideGain
	mid := 0.5 * (l + r) * e.extended.currentMid
	side := 0.5 * (l - r) * e.extended.currentSide

	if !e.params.Stereo.MonoBass {
		side *= width
		return mid + side, mid - side
	}

	// Four cascaded second-order Butterworth high-passes on the Side channel.
	// This heuristic is not a textbook Linkwitz-Riley crossover.
	_, s1 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[0], side)
	_, s2 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[1], s1)
	_, s3 := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[2], s2)
	_, highSide := processSVFLowHigh(e.xoverCoeffs, &e.xoverSide[3], s3)

	// Narrow only the side signal. Injecting it into mid changes the mono mix.
	scaledSide := highSide * width
	return mid + scaledSide, mid - scaledSide
}

// estimateTruePeak4x approximates inter-sample peaks with cubic interpolation.
// It is not the BS.1770 reconstruction filter and can underestimate true peaks.
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
	ceilingLin := e.stages.limiterCeiling

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

	relCoeff := e.stages.limiterRelease

	if reqGain < e.limEnvLin {
		// Instant sample-peak attack. This cannot guarantee reconstructed peaks.
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

// processTruePeakStage runs the v2 limiter stage for one frame and returns the
// frame delayed by the lookahead. A disabled limiter or TruePeak=false still
// pass through the same delay so v2 latency never depends on settings.
func (e *Engine) processTruePeakStage(l, r, rawL, rawR float64, limActive bool) (float64, float64, float64, float64) {
	limit := limActive && e.params.Limiter.TruePeak
	if limActive && !limit {
		l, r = e.processLimiterSample(l, r)
	} else if !limActive {
		e.lastLimGRDB = 0
	}
	ceiling := e.stages.limiterCeiling
	l, r, rawL, rawR, gain := e.truePeak.process(l, r, rawL, rawR, ceiling, e.stages.limiterRelease, limit)
	if !limit {
		return l, r, rawL, rawR
	}
	e.lastLimGRDB = math.Max(0, -linToDB(gain))
	return math.Max(-ceiling, math.Min(ceiling, l)), math.Max(-ceiling, math.Min(ceiling, r)), rawL, rawR
}

// truePeakPassthrough keeps v2 bypass bit-identical to the source, delayed by
// the same lookahead as processed audio so toggling bypass stays aligned.
func (e *Engine) truePeakPassthrough(inL, inR float32) (float32, float32) {
	l, r := float64(inL), float64(inR)
	if math.IsNaN(l) || math.IsInf(l, 0) {
		l = 0
	}
	if math.IsNaN(r) || math.IsInf(r, 0) {
		r = 0
	}
	_, _, l, r, _ = e.truePeak.process(l, r, l, r, e.stages.limiterCeiling, e.stages.limiterRelease, false)
	return float32(l), float32(r)
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

// ditherScale is the quantization step count per unit for dithered output, or 0.
func ditherScale(bits int) float64 {
	switch bits {
	case 16:
		return 32768.0
	case 24:
		return 8388608.0
	default:
		return 0
	}
}

func (e *Engine) applyTPDFDither(sample float64, bits int) float64 {
	scale := ditherScale(bits)
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
