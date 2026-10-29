package mastering

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

const (
	// MaxStartingCeilingDBTP is the highest limiter ceiling any target or profile starts from.
	MaxStartingCeilingDBTP = dsp.MaxCeilingDBTP
	// SectionMoveMaxEQBoostDB caps a generated section move's EQ boost above its baseline (MUB-5).
	SectionMoveMaxEQBoostDB = 0.8
	// SectionMoveMaxWidthBoostPct caps a generated section move's width increase in percentage points.
	SectionMoveMaxWidthBoostPct = 8.0
	// SectionMoveMaxDriveBoostDB caps a generated section move's saturation drive increase.
	SectionMoveMaxDriveBoostDB = 0.5
	// MaxUnexplainedLoudnessRiseLU is the largest predicted loudness rise without a finding.
	MaxUnexplainedLoudnessRiseLU = 1.0
	// MaxUnexplainedCrestCutDB is the largest predicted crest-factor cut without a finding.
	MaxUnexplainedCrestCutDB = 4.0
	// MaxUnexplainedLimiterReductionDB is the largest predicted peak limiter reduction without a finding.
	MaxUnexplainedLimiterReductionDB = 4.0
	// MaxLevelMatchGainDB bounds the Level match gain a proposal may add.
	MaxLevelMatchGainDB = 12.0
	// MaxLevelMatchLimiterReductionDB bounds the export limiter's predicted
	// peak reduction a positive Level match may cause: half the heavy-limiting
	// finding (V1-09 Round E ruling).
	MaxLevelMatchLimiterReductionDB = MaxUnexplainedLimiterReductionDB / 2
	// MaxDynamicLevelMatchLimiterReductionDB keeps Dynamic & Open's extra
	// limiting below the other profiles to preserve transient contrast.
	MaxDynamicLevelMatchLimiterReductionDB = 1.0
	// maxLevelMatchPredictions bounds the extra export renders the Level match search makes.
	maxLevelMatchPredictions = 3
	// levelMatchToleranceLU ends the search once the prediction is this close to the source.
	levelMatchToleranceLU = 0.1
)

// LevelMatch is the one explicit gain a Deep proposal uses to hold the
// source's loudness (V1-09 chair ruling). Apply sets it as compressor makeup.
type LevelMatch struct {
	// GainDB is the makeup gain the proposal applies, rounded to 0.1 dB.
	GainDB float64 `json:"gainDb"`
	// NeededDB is the loudness shortfall measured without it (source minus proposal).
	NeededDB float64 `json:"neededDb"`
	// LimiterCapped reports that the profile's limiting cap, not the need, set GainDB.
	LimiterCapped bool `json:"limiterCapped"`
}

// ProposalPrediction is the measurement of a proposal rendered exactly as an
// export renders it: the algorithm 2 lookahead true-peak limiter at the source
// rate, before optional rate conversion and dither.
type ProposalPrediction struct {
	// levelMatchLimitDB is the profile's search policy, not a wire field.
	levelMatchLimitDB float64
	AfterMetrics      dsp.Metrics `json:"afterMetrics"`
	LevelMatch        LevelMatch  `json:"levelMatch"`
	// CompressorAverageGainReductionDB averages the compressor's reduction over audible frames.
	CompressorAverageGainReductionDB float64 `json:"compressorAverageGainReductionDb"`
	// LimiterPeakGainReductionDB is the export limiter's largest reduction.
	LimiterPeakGainReductionDB float64 `json:"limiterPeakGainReductionDb"`
}

type proposalRecipe struct {
	eq                         [dsp.NumEQBands]float64
	freq                       [dsp.NumEQBands]float64 // 0 keeps the default band frequency
	threshold, ratio           float64
	attack, release, sidechain float64
	topology                   dsp.CompTopology
	character                  dsp.SatCharacter
	drive, width               float64
	monoBass                   bool
	// averageGR is the average compressor reduction (dB) the measured
	// threshold aims for; threshold is only the unmeasured fallback.
	averageGR float64
}

// Conservative Deep starting points on the same scale as the Simple presets in
// docs/mastering-controls-research.md. Each has one signature EQ move of at
// least 1 dB that matches its name. They add no makeup or input gain: the
// measured Level match gain is the only loudness change (V1-09 chair ruling).
var proposalRecipes = map[ProfileID]proposalRecipe{
	// Low-mid body (250 Hz +1.1) with a softened top and tube color.
	ProfileWarmAnalog: {eq: [5]float64{0.5, 1.1, 0, -0.4, -0.8}, threshold: -16, ratio: 1.7, attack: 30, release: 250, sidechain: 90, topology: dsp.CompOptical, character: dsp.SatTube, drive: 8, width: 100, averageGR: 1.5},
	// Attack and presence (4 kHz +1.2) over a cleared 250 Hz; VCA control.
	ProfilePunchyCommercial: {eq: [5]float64{0.6, -0.8, 0, 1.2, 0.5}, threshold: -16, ratio: 2, attack: 30, release: 150, sidechain: 90, topology: dsp.CompVCA, character: dsp.SatTransformer, drive: 4, width: 104, monoBass: true, averageGR: 1.5},
	// Air (12 kHz shelf +1.2) and the lightest compression.
	ProfileDynamicOpen: {eq: [5]float64{0.2, -0.3, 0, 0.2, 1.2}, threshold: -14, ratio: 1.4, attack: 40, release: 300, sidechain: 60, topology: dsp.CompOptical, character: dsp.SatClean, drive: 0, width: 104, averageGR: 0.75},
	// Vocal intelligibility (2 kHz +1.2) with a 250 Hz masking cut.
	ProfileVocalForward: {eq: [5]float64{0, -0.6, 1.2, 0.3, 0.3}, freq: [5]float64{2: 2000}, threshold: -17, ratio: 1.7, attack: 30, release: 200, sidechain: 100, topology: dsp.CompOptical, character: dsp.SatTube, drive: 3, width: 100, monoBass: true, averageGR: 1.5},
	// Sub shelf (+1.5 at 90 Hz, about +1.2 at 120 Hz) with a 250 Hz mud cut; VCA control.
	ProfileBassHeavy: {eq: [5]float64{1.5, -0.6, 0, 0, 0.2}, freq: [5]float64{0: 90}, threshold: -16, ratio: 1.8, attack: 30, release: 200, sidechain: 120, topology: dsp.CompVCA, character: dsp.SatTape, drive: 4, width: 102, monoBass: true, averageGR: 1.5},
}

// ProposalBaseline returns the static baseline a measured Deep proposal starts
// from, with its fallback threshold. AnalyzeDeepV2Context measures the source
// to set the threshold and the Level match gain.
func ProposalBaseline(profile ProfileID) dsp.Params {
	recipe, ok := proposalRecipes[profile]
	if !ok {
		recipe = proposalRecipes[ProfileWarmAnalog]
	}
	p := dsp.DefaultParams()
	p.AlgorithmVersion = dsp.LegacyAlgorithmVersion
	p.EQEnabled = true
	for i := range p.Bands {
		p.Bands[i].GainDB = recipe.eq[i]
		if recipe.freq[i] > 0 {
			p.Bands[i].FreqHz = recipe.freq[i]
		}
	}
	// Auto release stays off so the listed release is the one applied.
	p.Compressor = dsp.CompressorParams{Enabled: true, ThresholdDB: recipe.threshold, Ratio: recipe.ratio, AttackMS: recipe.attack, ReleaseMS: recipe.release, KneeDB: 6, MakeupDB: 0, SidechainHPFHz: recipe.sidechain, AutoRelease: false, Topology: recipe.topology}
	p.Saturation = dsp.SaturationParams{Enabled: recipe.drive > 0, Amount: recipe.drive, Character: recipe.character}
	p.Stereo.Enabled = true
	p.Stereo.WidthPct = recipe.width
	p.Stereo.MonoBass = recipe.monoBass
	p.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: MaxStartingCeilingDBTP, TargetLUFS: p.Limiter.TargetLUFS, ReleaseMS: 85, TruePeak: false}
	p.Repair = dsp.RepairParams{}
	return p
}

func driveScale(character dsp.SatCharacter) float64 {
	switch character {
	case dsp.SatTube, dsp.SatTape, dsp.SatTransformer:
		return 3
	case dsp.SatWarm, dsp.SatThick, dsp.SatCrisp, dsp.SatClean:
		return 3.2
	default:
		return 3.2
	}
}

// CapSectionMove limits the boosts a generated section move may apply above
// its baseline (MUB-5): +0.8 dB EQ, +8 width points and +0.5 dB drive.
// Cuts and other targets pass unchanged; the argument is not mutated.
func CapSectionMove(base dsp.Params, move automation.Move) automation.Move {
	var baseline, limit float64
	switch {
	case strings.HasPrefix(move.Target, "eq.") && strings.HasSuffix(move.Target, ".gainDb"):
		index, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(move.Target, "eq."), ".gainDb"))
		if err != nil || index < 0 || index >= dsp.NumEQBands {
			return move
		}
		baseline, limit = base.Bands[index].GainDB, SectionMoveMaxEQBoostDB
	case move.Target == "stereo.widthPct":
		baseline, limit = base.Stereo.WidthPct, SectionMoveMaxWidthBoostPct
	case move.Target == "saturation.amount":
		baseline = base.Saturation.Amount
		scale := driveScale(base.Saturation.Character)
		limit = (1 + scale*baseline/100) * (math.Pow(10, SectionMoveMaxDriveBoostDB/20) - 1) / scale * 100
	default:
		return move
	}
	capped := move
	capped.Points = append([]automation.Point(nil), move.Points...)
	for i, point := range capped.Points {
		if move.Operation == "absolute" {
			capped.Points[i].Value = math.Min(point.Value, baseline+limit)
		} else {
			capped.Points[i].Value = math.Min(point.Value, limit)
		}
	}
	return capped
}

// exportScriptV2 returns a copy of script that renders with the export
// algorithm: algorithm 2 and its lookahead true-peak limiter, no dither.
// The browser's exportScript (src/lib/engine-params.ts) must match it; the
// shared golden testdata/export-transform.golden.json checks both.
func exportScriptV2(script *ScriptV2) *ScriptV2 {
	exported := script.Clone()
	if exported.ChainParams.AlgorithmVersion != dsp.OversampledAlgorithmVersion {
		exported.ChainParams.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	}
	exported.ChainParams.Limiter.TruePeak = true
	exported.ChainParams.DitherBits = 0
	return exported
}

// predictExportContext renders a copy of the proposal through the export
// algorithm and measures it. The proposal itself is unchanged.
func predictExportContext(ctx context.Context, buf *audio.Buffer, script *ScriptV2) (ProposalPrediction, error) {
	_, _, metrics, stats, err := renderScriptV2Context(ctx, buf, exportScriptV2(script))
	if err != nil {
		return ProposalPrediction{}, err
	}
	return ProposalPrediction{AfterMetrics: metrics, CompressorAverageGainReductionDB: stats.CompressorAverageDB, LimiterPeakGainReductionDB: stats.LimiterPeakDB}, nil
}

func roundLevelMatch(gainDB float64) float64 { return math.Round(gainDB*10) / 10 }

// levelMatchBound estimates the largest gain that keeps the export limiter's
// peak reduction within the cap. Peaks rise at most 1 dB per dB of gain, so
// the limiter takes no more than the gain beyond the true-peak headroom.
func levelMatchBound(gainDB, ceilingDBTP float64, prediction ProposalPrediction) float64 {
	headroom := prediction.levelMatchLimit() - prediction.LimiterPeakGainReductionDB
	if prediction.LimiterPeakGainReductionDB < 0.01 {
		headroom += math.Max(0, ceilingDBTP-prediction.AfterMetrics.TruePeakDBTP)
	}
	return gainDB + headroom
}

func (p ProposalPrediction) levelMatchLimit() float64 {
	if p.levelMatchLimitDB > 0 {
		return p.levelMatchLimitDB
	}
	return MaxLevelMatchLimiterReductionDB
}

// searchLevelMatch finds the one gain that holds the source's integrated
// loudness (beforeLUFS) within the profile's peak-reduction limit (2 dB by
// default), re-rendering at most three times. render must return the export
// render of the proposal with that gain as makeup; the returned prediction is
// the render of the returned gain (0 is initial).
func searchLevelMatch(beforeLUFS, ceilingDBTP float64, initial ProposalPrediction, render func(gainDB float64) (ProposalPrediction, error)) (ProposalPrediction, error) {
	limiterLimit := initial.levelMatchLimit()
	type trial struct {
		gain       float64
		prediction ProposalPrediction
	}
	shortfall := func(t trial) float64 { return beforeLUFS - t.prediction.AfterMetrics.IntegratedLUFS }
	best, last := trial{0, initial}, trial{0, initial}
	tried := map[float64]bool{0: true}
	rejected, bounded := math.Inf(1), false
	next := shortfall(best)
	for range maxLevelMatchPredictions {
		gain := math.Min(next, MaxLevelMatchGainDB)
		if bound := levelMatchBound(last.gain, ceilingDBTP, last.prediction); gain > 0 && gain > bound {
			gain, bounded = math.Floor(bound*10+1e-6)/10, true
		}
		gain = math.Min(roundLevelMatch(gain), roundLevelMatch(rejected-0.1))
		if tried[gain] || (gain > 0 && gain <= best.gain && best.gain > 0) || (gain <= 0 && next > 0) {
			break
		}
		tried[gain] = true
		prediction, err := render(gain)
		if err != nil {
			return ProposalPrediction{}, err
		}
		prediction.levelMatchLimitDB = limiterLimit
		current := trial{gain, prediction}
		if gain > 0 && prediction.LimiterPeakGainReductionDB > limiterLimit {
			// Too much limiting: step back by the excess reduction.
			rejected, bounded = gain, true
			next = gain - (prediction.LimiterPeakGainReductionDB - limiterLimit)
			last = current
			continue
		}
		if math.Abs(shortfall(current)) < math.Abs(shortfall(best)) {
			best = current
		}
		if math.Abs(shortfall(current)) <= levelMatchToleranceLU {
			break
		}
		// Secant step: past the ceiling the limiter takes back part of each dB.
		slope := 1.0
		if gain != last.gain {
			slope = math.Max(0.25, math.Min(1, (prediction.AfterMetrics.IntegratedLUFS-last.prediction.AfterMetrics.IntegratedLUFS)/(gain-last.gain)))
		}
		next, last = gain+shortfall(current)/slope, current
	}
	match := LevelMatch{GainDB: best.gain + 0, NeededDB: shortfall(trial{0, initial})} // + 0 normalizes -0
	match.LimiterCapped = bounded && shortfall(best) > levelMatchToleranceLU && best.gain < MaxLevelMatchGainDB
	best.prediction.LevelMatch = match
	return best.prediction, nil
}

// predictionFindings explains measured changes large enough to bias a
// comparison: a loudness change above 1 LU, a crest cut above 4 dB or a peak
// limiter reduction above 4 dB. prediction is nil for legacy version 1 scripts.
func predictionFindings(before, after dsp.Metrics, prediction *ProposalPrediction) []Finding {
	if before.IntegratedLUFS <= -70 {
		return nil
	}
	findings := []Finding{}
	if prediction != nil && prediction.LevelMatch.LimiterCapped && prediction.LevelMatch.GainDB == 0 && prediction.LimiterPeakGainReductionDB > prediction.levelMatchLimit() {
		findings = append(findings, Finding{ID: "predicted-source-limiting", Severity: "warning", Lane: "Dynamics",
			Title:  "Limiting is already active before Level match",
			Detail: fmt.Sprintf("This source and proposal already need %.1f dB of export limiting before any Level match gain. The listed +0.0 dB adds no level; lower the source input or choose a gentler proposal if the transients sound flattened.", prediction.LimiterPeakGainReductionDB)})
	}
	if rise := after.IntegratedLUFS - before.IntegratedLUFS; rise > MaxUnexplainedLoudnessRiseLU {
		findings = append(findings, Finding{ID: "predicted-loudness-increase", Severity: "warning", Lane: "Volume",
			Title:  fmt.Sprintf("Proposal raises loudness by %.1f LU", rise),
			Detail: fmt.Sprintf("Rendered through the export limiter, this proposal measures %.1f LUFS against the source's %.1f LUFS. Louder playback can sound better without being better; after Apply, turn on Equal-loudness A/B on the transport to compare at equal loudness.", after.IntegratedLUFS, before.IntegratedLUFS)})
	}
	if drop := before.IntegratedLUFS - after.IntegratedLUFS; drop > MaxUnexplainedLoudnessRiseLU {
		cause := "A quieter result can sound worse in comparison; after Apply, turn on Equal-loudness A/B on the transport, or use Set target loudness."
		switch {
		case prediction == nil:
		case prediction.LevelMatch.LimiterCapped:
			cause = fmt.Sprintf("Holding the source loudness would need more than %.0f dB of limiting; the proposal is %.1f LU quieter with a %s Level match. Raise the level yourself only if the extra limiting sounds clean.", prediction.levelMatchLimit(), drop, signedDB(prediction.LevelMatch.GainDB))
		case prediction.LevelMatch.GainDB >= MaxLevelMatchGainDB:
			cause = fmt.Sprintf("Holding the source loudness needs %s; the Level match stops at %s; after Apply, turn on Equal-loudness A/B on the transport, or use Set target loudness.", signedDB(prediction.LevelMatch.NeededDB), signedDB(MaxLevelMatchGainDB))
		default:
			cause = fmt.Sprintf("The %s Level match gain did not hold the source loudness; after Apply, turn on Equal-loudness A/B on the transport, or use Set target loudness.", signedDB(prediction.LevelMatch.GainDB))
		}
		findings = append(findings, Finding{ID: "predicted-loudness-decrease", Severity: "info", Lane: "Volume",
			Title:  fmt.Sprintf("Proposal lowers loudness by %.1f LU", drop),
			Detail: fmt.Sprintf("Rendered through the export limiter, this proposal measures %.1f LUFS against the source's %.1f LUFS. %s", after.IntegratedLUFS, before.IntegratedLUFS, cause)})
	}
	if cut := before.DynamicRangeDB - after.DynamicRangeDB; cut > MaxUnexplainedCrestCutDB {
		findings = append(findings, Finding{ID: "predicted-crest-reduction", Severity: "warning", Lane: "Dynamics",
			Title:  fmt.Sprintf("Proposal reduces crest factor by %.1f dB", cut),
			Detail: fmt.Sprintf("Rendered through the export limiter, the true-peak to RMS crest falls from %.1f dB to %.1f dB. Transients can lose impact; reduce compression, saturation or limiting if the source's punch matters.", before.DynamicRangeDB, after.DynamicRangeDB)})
	}
	if prediction != nil && prediction.LimiterPeakGainReductionDB > MaxUnexplainedLimiterReductionDB {
		findings = append(findings, Finding{ID: "predicted-heavy-limiting", Severity: "warning", Lane: "Dynamics",
			Title:  fmt.Sprintf("Export limiter reduces peaks by up to %.1f dB", prediction.LimiterPeakGainReductionDB),
			Detail: fmt.Sprintf("Rendered through the export limiter, the largest limiter gain reduction is %.1f dB. Above %.0f dB, dense mixes can lose transient detail and sound flattened; lower the input or Level match, or accept a quieter master.", prediction.LimiterPeakGainReductionDB, MaxUnexplainedLimiterReductionDB)})
	}
	return findings
}

func signedDB(value float64) string {
	text := fmt.Sprintf("%+.1f dB", value)
	return strings.Replace(text, "-", "−", 1)
}

// calibrateCompressorThreshold sets the threshold that gives the target
// average reduction on this source. Reduction falls as the threshold rises,
// so a bracketed Illinois (modified false-position) search converges in a few
// EQ-and-compressor renders.
func calibrateCompressorThreshold(ctx context.Context, buf *audio.Buffer, params dsp.Params, targetDB, peakDBFS float64) (dsp.Params, error) {
	eval := func(threshold float64) (float64, error) {
		p := params
		p.Compressor.ThresholdDB = threshold
		gr, err := measureCompressorAverageGR(ctx, buf, p)
		return gr - targetDB, err
	}
	finish := func(threshold float64) (dsp.Params, error) {
		params.Compressor.ThresholdDB = math.Round(threshold*10) / 10
		return params, nil
	}
	high := math.Min(0, math.Max(-60, peakDBFS+1))
	low := math.Max(-60, high-36)
	fLow, err := eval(low)
	if err != nil {
		return params, err
	}
	if fLow <= 0 {
		return finish(low) // Too quiet to reach the target: compress from the lowest bracket.
	}
	fHigh, err := eval(high)
	if err != nil {
		return params, err
	}
	if fHigh >= 0 {
		return finish(high)
	}
	side := 0
	for range 10 {
		threshold := high - fHigh*(high-low)/(fHigh-fLow)
		f, err := eval(threshold)
		if err != nil {
			return params, err
		}
		if math.Abs(f) < 0.05 {
			return finish(threshold)
		}
		if f > 0 {
			low, fLow = threshold, f
			if side == 1 {
				fHigh /= 2
			}
			side = 1
		} else {
			high, fHigh = threshold, f
			if side == -1 {
				fLow /= 2
			}
			side = -1
		}
	}
	if -fHigh < fLow {
		return finish(high)
	}
	return finish(low)
}

// measureCompressorAverageGR renders only the stages that feed the compressor
// (input gain, EQ and the compressor itself) and returns its average reduction
// over audible frames.
func measureCompressorAverageGR(ctx context.Context, buf *audio.Buffer, params dsp.Params) (float64, error) {
	p := params
	p.AlgorithmVersion = dsp.LegacyAlgorithmVersion
	p.Saturation.Enabled = false
	p.Stereo.Enabled = false
	p.Limiter.Enabled = false
	p.DitherBits = 0
	if err := dsp.ValidateParams(p); err != nil {
		return 0, err
	}
	engine := dsp.NewEngine(float64(buf.SampleRate))
	engine.SetParams(p)
	const block = 4096
	outL, outR := make([]float32, block), make([]float32, block)
	for start := 0; start < len(buf.Left); start += block {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		end := min(start+block, len(buf.Left))
		engine.ProcessBlock(buf.Left[start:end], buf.Right[start:end], outL[:end-start], outR[:end-start])
	}
	return engine.GainReductionStats().CompressorAverageDB, nil
}
