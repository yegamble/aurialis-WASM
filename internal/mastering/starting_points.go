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
)

// ProposalPrediction is the measurement of a proposal rendered exactly as an
// export renders it: the algorithm 2 lookahead true-peak limiter at the source
// rate, before optional rate conversion and dither.
type ProposalPrediction struct {
	AfterMetrics dsp.Metrics `json:"afterMetrics"`
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

// predictExportContext renders a copy of the proposal through the export
// algorithm and measures it. The proposal itself is unchanged.
func predictExportContext(ctx context.Context, buf *audio.Buffer, script *ScriptV2) (ProposalPrediction, error) {
	exported := script.Clone()
	exported.ChainParams.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	exported.ChainParams.Limiter.TruePeak = true
	exported.ChainParams.DitherBits = 0
	_, _, metrics, err := RenderScriptV2Context(ctx, buf, exported)
	if err != nil {
		return ProposalPrediction{}, err
	}
	return ProposalPrediction{AfterMetrics: metrics}, nil
}

// predictionFindings explains measured changes large enough to bias a
// comparison: a loudness rise above 1 LU or a crest cut above 4 dB.
func predictionFindings(before, after dsp.Metrics) []Finding {
	if before.IntegratedLUFS <= -70 {
		return nil
	}
	findings := []Finding{}
	if rise := after.IntegratedLUFS - before.IntegratedLUFS; rise > MaxUnexplainedLoudnessRiseLU {
		findings = append(findings, Finding{ID: "predicted-loudness-increase", Severity: "warning", Lane: "Volume",
			Title:  fmt.Sprintf("Proposal raises loudness by %.1f LU", rise),
			Detail: fmt.Sprintf("Rendered through the export limiter, this proposal measures %.1f LUFS against the source's %.1f LUFS. Louder playback can sound better without being better; compare at matched loudness before applying.", after.IntegratedLUFS, before.IntegratedLUFS)})
	}
	if drop := before.IntegratedLUFS - after.IntegratedLUFS; drop > MaxUnexplainedLoudnessRiseLU {
		findings = append(findings, Finding{ID: "predicted-loudness-decrease", Severity: "info", Lane: "Volume",
			Title:  fmt.Sprintf("Proposal lowers loudness by %.1f LU", drop),
			Detail: fmt.Sprintf("Rendered through the export limiter, this proposal measures %.1f LUFS against the source's %.1f LUFS because the baseline adds no makeup gain. A quieter result can sound worse in comparison; compare at matched loudness or use Set target loudness.", after.IntegratedLUFS, before.IntegratedLUFS)})
	}
	if cut := before.DynamicRangeDB - after.DynamicRangeDB; cut > MaxUnexplainedCrestCutDB {
		findings = append(findings, Finding{ID: "predicted-crest-reduction", Severity: "warning", Lane: "Dynamics",
			Title:  fmt.Sprintf("Proposal reduces crest factor by %.1f dB", cut),
			Detail: fmt.Sprintf("Rendered through the export limiter, the true-peak to RMS crest falls from %.1f dB to %.1f dB. Transients can lose impact; reduce compression, saturation or limiting if the source's punch matters.", before.DynamicRangeDB, after.DynamicRangeDB)})
	}
	return findings
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
