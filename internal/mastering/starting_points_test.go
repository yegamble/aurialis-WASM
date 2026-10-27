package mastering

import (
	"context"
	"math"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

var allProfiles = []ProfileID{ProfileWarmAnalog, ProfilePunchyCommercial, ProfileDynamicOpen, ProfileVocalForward, ProfileBassHeavy}

// V1-09: every starting point holds a -1 dBTP ceiling and adds no makeup or
// input gain; the tonal, dynamic and width recipes stay conservative (MUB-5).
func TestProposalBaselinesAreHonestStartingPoints(t *testing.T) {
	for _, profile := range allProfiles {
		params := ProposalBaseline(profile)
		if err := dsp.ValidateParams(params); err != nil {
			t.Fatal(profile, err)
		}
		if !params.Limiter.Enabled || params.Limiter.CeilingDBTP > MaxStartingCeilingDBTP || params.Limiter.TruePeak || params.AlgorithmVersion != dsp.LegacyAlgorithmVersion {
			t.Fatalf("%s limiter is not a -1 dBTP live baseline: %+v", profile, params.Limiter)
		}
		if params.Compressor.MakeupDB != 0 || params.InputGainDB != 0 || params.Stereo.MidGainDB != 0 || params.Stereo.SideGainDB != 0 {
			t.Fatalf("%s baseline adds level: makeup %.2f input %.2f", profile, params.Compressor.MakeupDB, params.InputGainDB)
		}
		for i, band := range params.Bands {
			if math.Abs(band.GainDB) > 1.5 {
				t.Fatalf("%s band %d moves %.2f dB; conservative recipes stay within 1.5 dB", profile, i, band.GainDB)
			}
		}
		if params.Compressor.Ratio > 2 || params.Saturation.Amount > 10 || params.Stereo.WidthPct > 106 || params.Stereo.WidthPct < 100 {
			t.Fatalf("%s dynamics, drive or width exceed the conservative recipe: %+v", profile, params)
		}
		if params.Repair.Enabled || params.Compressor.AutoRelease {
			t.Fatalf("%s uses unavailable processing or overrides its listed release", profile)
		}
	}
	// Legacy v1 presets keep their character but no longer exceed -1 dBTP.
	for _, profile := range allProfiles {
		if ceiling := ProfilePreset(profile).Limiter.CeilingDBTP; ceiling > MaxStartingCeilingDBTP {
			t.Fatalf("legacy %s ceiling %.2f dBTP above -1", profile, ceiling)
		}
	}
}

// S1: each profile has at least one 1 dB signature move that matches its name,
// measured as the baseline EQ response, and stands out from every other profile.
func TestProfileSignaturesMatchTheirNames(t *testing.T) {
	signatures := []struct {
		profile   ProfileID
		frequency []float64
		topology  dsp.CompTopology
	}{
		{ProfileWarmAnalog, []float64{250}, dsp.CompOptical},    // low-mid body
		{ProfilePunchyCommercial, []float64{4000}, dsp.CompVCA}, // attack and presence
		{ProfileDynamicOpen, []float64{12000}, dsp.CompOptical}, // air
		{ProfileVocalForward, []float64{2000}, dsp.CompOptical}, // vocal intelligibility
		{ProfileBassHeavy, []float64{40, 120}, dsp.CompVCA},     // sub and the 120 Hz bump
	}
	response := func(profile ProfileID, frequency float64) float64 {
		params := ProposalBaseline(profile)
		return dsp.EQResponseDB(48000, frequency, params.EQEnabled, params.Bands)
	}
	for _, signature := range signatures {
		params := ProposalBaseline(signature.profile)
		if params.Compressor.Topology != signature.topology {
			t.Fatalf("%s uses %s, want %s", signature.profile, params.Compressor.Topology, signature.topology)
		}
		largest := 0.0
		for _, band := range params.Bands {
			largest = math.Max(largest, math.Abs(band.GainDB))
		}
		if largest < 1 {
			t.Fatalf("%s has no 1 dB signature move", signature.profile)
		}
		for _, frequency := range signature.frequency {
			own := response(signature.profile, frequency)
			if own < 1 {
				t.Fatalf("%s measures %+.2f dB at %.0f Hz, want at least +1 dB", signature.profile, own, frequency)
			}
			for _, other := range allProfiles {
				if other != signature.profile && own-response(other, frequency) < 0.5 {
					t.Fatalf("%s (%+.2f dB) does not stand out from %s (%+.2f dB) at %.0f Hz", signature.profile, own, other, response(other, frequency), frequency)
				}
			}
		}
	}
	// Bass Heavy no longer cuts the bass it is named for; Warm Analog is the darkest top.
	if response(ProfileBassHeavy, 120) <= response(ProfileBassHeavy, 250) || response(ProfileBassHeavy, 250) > -0.3 {
		t.Fatal("Bass Heavy must lift 120 Hz and clear 250 Hz")
	}
	for _, other := range allProfiles {
		if other != ProfileWarmAnalog && response(ProfileWarmAnalog, 12000) >= response(other, 12000) {
			t.Fatalf("Warm Analog is not darker than %s at 12 kHz", other)
		}
	}
}

// R3: each profile's listed release is audible. Doubling it changes the
// measured compressor reduction, so the field is not a placebo.
func TestProfileReleaseTimesAreAudible(t *testing.T) {
	buf := referenceMix(3, true)
	ctx := context.Background()
	for _, profile := range allProfiles {
		params := ProposalBaseline(profile)
		params.Compressor.ThresholdDB = -20
		short, err := measureCompressorAverageGR(ctx, buf, params)
		if err != nil {
			t.Fatal(err)
		}
		params.Compressor.ReleaseMS *= 3
		long, err := measureCompressorAverageGR(ctx, buf, params)
		if err != nil {
			t.Fatal(err)
		}
		if long-short < 0.1 {
			t.Fatalf("%s release is inaudible: %.3f dB vs %.3f dB average reduction", profile, short, long)
		}
	}
}

func TestSectionMoveCapsFollowMUB5(t *testing.T) {
	base := ProposalBaseline(ProfileWarmAnalog)
	move := func(target, operation string, values ...float64) automation.Move {
		points := make([]automation.Point, len(values))
		for i, value := range values {
			points[i] = automation.Point{Frame: int64(i * 100), Value: value}
		}
		return automation.Move{ID: "m", SectionID: "s", Target: target, Operation: operation, Points: points}
	}
	capped := CapSectionMove(base, move("eq.0.gainDb", "add", 2, -3, .5))
	if capped.Points[0].Value != SectionMoveMaxEQBoostDB || capped.Points[1].Value != -3 || capped.Points[2].Value != .5 {
		t.Fatal("EQ add move not capped at +0.8 dB", capped.Points)
	}
	capped = CapSectionMove(base, move("eq.4.gainDb", "absolute", base.Bands[4].GainDB+3))
	if math.Abs(capped.Points[0].Value-(base.Bands[4].GainDB+SectionMoveMaxEQBoostDB)) > 1e-9 {
		t.Fatal("absolute EQ move not capped relative to its baseline", capped.Points)
	}
	capped = CapSectionMove(base, move("stereo.widthPct", "add", 20))
	if capped.Points[0].Value != SectionMoveMaxWidthBoostPct {
		t.Fatal("width add move not capped at +8%", capped.Points)
	}
	capped = CapSectionMove(base, move("stereo.widthPct", "absolute", 150))
	if capped.Points[0].Value != base.Stereo.WidthPct+SectionMoveMaxWidthBoostPct {
		t.Fatal("absolute width move not capped relative to its baseline", capped.Points)
	}
	capped = CapSectionMove(base, move("saturation.amount", "add", 40))
	driveDB := func(amount float64) float64 { return 20 * math.Log10(1+3*amount/100) }
	delta := driveDB(base.Saturation.Amount+capped.Points[0].Value) - driveDB(base.Saturation.Amount)
	if math.Abs(delta-SectionMoveMaxDriveBoostDB) > 1e-9 {
		t.Fatalf("drive delta %.4f dB, want %.1f dB", delta, SectionMoveMaxDriveBoostDB)
	}
	original := move("inputGainDb", "add", -.5, -.5)
	if capped = CapSectionMove(base, original); capped.Points[0].Value != -.5 {
		t.Fatal("input trims are not MUB-5 boosts and must stay unchanged")
	}
	if original.Points[0].Value != -.5 {
		t.Fatal("capping mutated its input")
	}
}

func TestPredictionFindingsExplainLoudnessAndCrestChanges(t *testing.T) {
	before := dsp.Metrics{IntegratedLUFS: -16, DynamicRangeDB: 14}
	limited := &ProposalPrediction{LevelMatch: LevelMatch{GainDB: 0.4, NeededDB: 2.9, LimiterCapped: true}}
	for _, tc := range []struct {
		name       string
		after      dsp.Metrics
		prediction *ProposalPrediction
		want       []string
	}{
		{"within", dsp.Metrics{IntegratedLUFS: -15.1, DynamicRangeDB: 10.1}, nil, nil},
		{"louder", dsp.Metrics{IntegratedLUFS: -14.5, DynamicRangeDB: 13}, nil, []string{"predicted-loudness-increase"}},
		{"crest", dsp.Metrics{IntegratedLUFS: -17, DynamicRangeDB: 9.5}, nil, []string{"predicted-crest-reduction"}},
		{"quieter", dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, nil, []string{"predicted-loudness-decrease"}},
		{"limiter cap", dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, limited, []string{"predicted-loudness-decrease"}},
		{"both", dsp.Metrics{IntegratedLUFS: -12, DynamicRangeDB: 8}, nil, []string{"predicted-loudness-increase", "predicted-crest-reduction"}},
		{"limiting", dsp.Metrics{IntegratedLUFS: -16, DynamicRangeDB: 13}, &ProposalPrediction{LimiterPeakGainReductionDB: 4.6}, []string{"predicted-heavy-limiting"}},
		{"light limiting", dsp.Metrics{IntegratedLUFS: -16, DynamicRangeDB: 13}, &ProposalPrediction{LimiterPeakGainReductionDB: 3.9}, nil},
	} {
		findings := predictionFindings(before, tc.after, tc.prediction)
		if len(findings) != len(tc.want) {
			t.Fatalf("%s: findings %+v, want %v", tc.name, findings, tc.want)
		}
		for i, finding := range findings {
			severity := "warning"
			if finding.ID == "predicted-loudness-decrease" {
				severity = "info"
			}
			if finding.ID != tc.want[i] || finding.Severity != severity || finding.Title == "" || !strings.Contains(finding.Detail, "export") {
				t.Fatalf("%s: unexpected finding %+v", tc.name, finding)
			}
		}
	}
	// A drop the 2 dB limiting cap leaves says so and how much quieter it is.
	if detail := predictionFindings(before, dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, limited)[0].Detail; !strings.Contains(detail, "more than 2 dB of limiting") || !strings.Contains(detail, "2.5 LU quieter") || !strings.Contains(detail, "only if the extra limiting sounds clean") {
		t.Fatal("limiter-capped drop does not explain the cap:", detail)
	}
	// A drop the +12 dB bound leaves names that bound instead.
	if detail := predictionFindings(before, dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, &ProposalPrediction{LevelMatch: LevelMatch{GainDB: MaxLevelMatchGainDB, NeededDB: 14.5}})[0].Detail; !strings.Contains(detail, "needs +14.5 dB") || !strings.Contains(detail, "stops at +12.0 dB") {
		t.Fatal("gain-capped drop does not explain the +12 dB bound:", detail)
	}
	// V1-11: every loudness-change finding that suggests a matched comparison
	// names the transport's Equal-loudness A/B toggle, which exists only after Apply.
	for _, tc := range []struct {
		after      dsp.Metrics
		prediction *ProposalPrediction
	}{
		{dsp.Metrics{IntegratedLUFS: -14.5, DynamicRangeDB: 13}, nil},
		{dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, nil},
		{dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, &ProposalPrediction{LevelMatch: LevelMatch{GainDB: MaxLevelMatchGainDB, NeededDB: 14.5}}},
		{dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, &ProposalPrediction{LevelMatch: LevelMatch{GainDB: 1}}},
	} {
		if detail := predictionFindings(before, tc.after, tc.prediction)[0].Detail; !strings.Contains(detail, "after Apply, turn on Equal-loudness A/B on the transport") || strings.Contains(detail, "matched loudness") {
			t.Fatal("loudness finding does not point at the Equal-loudness A/B toggle:", detail)
		}
	}
	if findings := predictionFindings(dsp.Metrics{IntegratedLUFS: -120}, dsp.Metrics{IntegratedLUFS: -60, DynamicRangeDB: 0}, nil); len(findings) != 0 {
		t.Fatal("silent source fabricated findings")
	}
}

// levelModel is a deterministic stand-in for the export render: loudness
// follows the gain until peaks pass the ceiling headroom, after which the
// limiter takes back part of each extra dB and its peak reduction grows 1:1.
type levelModel struct {
	afterLUFS, headroomDB, baseGRDB, slopeAboveCeiling float64
	renders                                            []float64
}

func (m *levelModel) render(gainDB float64) (ProposalPrediction, error) {
	m.renders = append(m.renders, gainDB)
	over := math.Max(0, gainDB-m.headroomDB)
	return ProposalPrediction{AfterMetrics: dsp.Metrics{IntegratedLUFS: m.afterLUFS + gainDB - (1-m.slopeAboveCeiling)*over, TruePeakDBTP: math.Min(-1, -1-m.headroomDB+gainDB)}, LimiterPeakGainReductionDB: m.baseGRDB + over}, nil
}

// R1 (Round E): the Level match holds the source loudness unless that needs
// more than 2 dB of export limiting; it never exceeds +12 dB and re-renders
// at most three times.
func TestLevelMatchHoldsLoudnessWithinTwoDBOfLimiting(t *testing.T) {
	for _, tc := range []struct {
		name        string
		model       levelModel
		gain, delta float64 // expected gain and max |Δ LUFS|
		capped      bool
	}{
		{"restores", levelModel{afterLUFS: -18.04, headroomDB: 9}, 2, 0.1, false},
		{"lowers", levelModel{afterLUFS: -14.5, headroomDB: 3}, -1.5, 0.1, false},
		{"tiny", levelModel{afterLUFS: -16.04, headroomDB: 3}, 0, 0.1, false},
		{"into limiter", levelModel{afterLUFS: -17.6, headroomDB: 1, slopeAboveCeiling: 0.6}, 1.9, 0.1, false},
		{"limiting cap", levelModel{afterLUFS: -19, headroomDB: 0.25, baseGRDB: 0.1, slopeAboveCeiling: 0.4}, 2.1, 2.3, true},
		{"already limited", levelModel{afterLUFS: -18, headroomDB: -2.5, slopeAboveCeiling: 0.2}, 0, 4.01, true},
		{"capped", levelModel{afterLUFS: -36, headroomDB: 30}, MaxLevelMatchGainDB, 8.01, false},
	} {
		model := tc.model
		initial, _ := model.render(0)
		model.renders = nil
		prediction, err := searchLevelMatch(-16, -1, initial, model.render)
		if err != nil {
			t.Fatal(err)
		}
		match := prediction.LevelMatch
		if math.Abs(match.GainDB-tc.gain) > 0.11 || match.LimiterCapped != tc.capped || math.Abs(match.NeededDB-(-16-initial.AfterMetrics.IntegratedLUFS)) > 1e-9 {
			t.Fatalf("%s: %+v after renders %v, want gain %.1f capped %t", tc.name, match, model.renders, tc.gain, tc.capped)
		}
		// The returned prediction is the render of the returned gain.
		if want, _ := (&levelModel{afterLUFS: model.afterLUFS, headroomDB: model.headroomDB, baseGRDB: model.baseGRDB, slopeAboveCeiling: model.slopeAboveCeiling}).render(match.GainDB); want.AfterMetrics != prediction.AfterMetrics || want.LimiterPeakGainReductionDB != prediction.LimiterPeakGainReductionDB {
			t.Fatalf("%s: prediction %+v is not the render of %+.1f dB", tc.name, prediction, match.GainDB)
		}
		if delta := prediction.AfterMetrics.IntegratedLUFS + 16; math.Abs(delta) > tc.delta {
			t.Fatalf("%s: Δ LUFS %+.2f, want within %.1f", tc.name, delta, tc.delta)
		}
		if match.GainDB > 0 && prediction.LimiterPeakGainReductionDB > MaxLevelMatchLimiterReductionDB {
			t.Fatalf("%s: Level match %+.1f dB drives %.2f dB of limiting", tc.name, match.GainDB, prediction.LimiterPeakGainReductionDB)
		}
		if len(model.renders) > maxLevelMatchPredictions {
			t.Fatalf("%s: %d renders %v", tc.name, len(model.renders), model.renders)
		}
	}
}

// referenceMix synthesizes a deterministic stereo program: kick, bass, chords
// and noise hats. Dense applies a soft clipper so its crest is limited.
func referenceMix(seconds float64, dense bool) *audio.Buffer {
	const rate = 48000
	frames := int(seconds * rate)
	left, right := make([]float32, frames), make([]float32, frames)
	state := uint32(1)
	noise := func() float64 {
		state = state*1664525 + 1013904223
		return float64(state)/float64(math.MaxUint32)*2 - 1
	}
	for i := range frames {
		t := float64(i) / rate
		beat := math.Mod(t, .5)
		kick := math.Exp(-beat*18) * math.Sin(2*math.Pi*(50+90*math.Exp(-beat*30))*beat)
		bass := .35 * math.Sin(2*math.Pi*55*t)
		chord := .12 * (math.Sin(2*math.Pi*220*t) + math.Sin(2*math.Pi*277.2*t) + math.Sin(2*math.Pi*329.6*t+.3))
		hat := .08 * math.Exp(-math.Mod(t, .125)*60) * noise()
		l := .5*kick + .5*bass + chord + hat
		r := .5*kick + .5*bass + .9*chord + .8*hat + .03*math.Sin(2*math.Pi*660*t)
		if dense {
			l, r = .94*math.Tanh(2.4*l), .94*math.Tanh(2.4*r)
		} else {
			l, r = .35*l, .35*r
		}
		left[i], right[i] = float32(l), float32(r)
	}
	return &audio.Buffer{Left: left, Right: right, SampleRate: rate, Channels: 2, Frames: frames, Duration: seconds}
}

func hasFinding(findings []Finding, id string) bool {
	for _, finding := range findings {
		if finding.ID == id {
			return true
		}
	}
	return false
}

// Audio verification: each profile's prediction is the actual export render
// (algorithm 2 true-peak limiter) and any loudness rise above 1 LU or crest
// cut above 4 dB carries a visible finding.
func TestDeepProfilesPredictExportLevelsAndExplainLargeChanges(t *testing.T) {
	t.Parallel()
	// The race detector slows these renders about 5x; it checks concurrency on
	// 2 s fixtures, and CI's non-race step runs the full 6 s verification.
	seconds := 6.0
	if raceEnabled {
		seconds = 2
	}
	fixtures := []struct {
		name string
		buf  *audio.Buffer
	}{{"dynamic", referenceMix(seconds, false)}, {"dense", referenceMix(seconds, true)}}
	for _, fixture := range fixtures {
		for _, profile := range allProfiles {
			// Read-only shared sources; each render is independent.
			t.Run(fixture.name+"/"+string(profile), func(t *testing.T) {
				t.Parallel()
				verifyProfilePrediction(t, fixture.name, fixture.buf, profile)
			})
		}
	}
}

func verifyProfilePrediction(t *testing.T, name string, buf *audio.Buffer, profile ProfileID) {
	t.Helper()
	ctx := context.Background()
	script, prediction, err := AnalyzeDeepV2Context(ctx, buf, profile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if prediction == nil {
		t.Fatal("missing prediction")
	}
	match := prediction.LevelMatch
	if script.ChainParams.Compressor.MakeupDB != match.GainDB || script.ChainParams.InputGainDB != 0 || script.ChainParams.Limiter.CeilingDBTP > MaxStartingCeilingDBTP {
		t.Fatalf("level changes other than the listed Level match %+v: makeup %.2f input %.2f", match, script.ChainParams.Compressor.MakeupDB, script.ChainParams.InputGainDB)
	}
	_, _, measured, err := RenderScriptV2Context(ctx, buf, exportScriptV2(script))
	if err != nil {
		t.Fatal(err)
	}
	if measured.IntegratedLUFS != prediction.AfterMetrics.IntegratedLUFS || measured.TruePeakDBTP != prediction.AfterMetrics.TruePeakDBTP || measured.DynamicRangeDB != prediction.AfterMetrics.DynamicRangeDB {
		t.Fatalf("prediction is not the export render: %+v vs %+v", prediction.AfterMetrics, measured)
	}
	if prediction.AfterMetrics.TruePeakDBTP > script.ChainParams.Limiter.CeilingDBTP {
		t.Fatalf("export true peak %.2f above ceiling", prediction.AfterMetrics.TruePeakDBTP)
	}
	rise := prediction.AfterMetrics.IntegratedLUFS - script.BeforeMetrics.IntegratedLUFS
	cut := script.BeforeMetrics.DynamicRangeDB - prediction.AfterMetrics.DynamicRangeDB
	// Round E ruling: loudness holds within 1 LU and a positive Level match
	// never drives the export limiter past 2 dB of peak reduction.
	if math.Abs(rise) > MaxUnexplainedLoudnessRiseLU {
		t.Fatalf("Δ LUFS %+.2f LU; level match %+v, limiter %.2f dB", rise, match, prediction.LimiterPeakGainReductionDB)
	}
	if match.GainDB > 0 && prediction.LimiterPeakGainReductionDB > MaxLevelMatchLimiterReductionDB {
		t.Fatalf("Level match %+.1f dB drives %.2f dB of limiter reduction", match.GainDB, prediction.LimiterPeakGainReductionDB)
	}
	if name == "dynamic" && math.Abs(rise) > 0.05 {
		t.Fatalf("dynamic source moved %+.2f LU", rise)
	}
	if (rise > MaxUnexplainedLoudnessRiseLU) != hasFinding(script.Findings, "predicted-loudness-increase") ||
		(-rise > MaxUnexplainedLoudnessRiseLU) != hasFinding(script.Findings, "predicted-loudness-decrease") ||
		(cut > MaxUnexplainedCrestCutDB) != hasFinding(script.Findings, "predicted-crest-reduction") ||
		(prediction.LimiterPeakGainReductionDB > MaxUnexplainedLimiterReductionDB) != hasFinding(script.Findings, "predicted-heavy-limiting") {
		t.Fatalf("rise %.2f LU cut %.2f dB limiter %.2f dB findings %+v", rise, cut, prediction.LimiterPeakGainReductionDB, script.Findings)
	}
	// R2: the measured threshold sets about 1-2 dB of average reduction (0.5-1 dB for Dynamic & Open).
	target := proposalRecipes[profile].averageGR
	if gr := prediction.CompressorAverageGainReductionDB; math.Abs(gr-target) > target/3 {
		t.Fatalf("average compressor reduction %.2f dB, want %.2f ± %.2f dB (threshold %.1f dBFS)", gr, target, target/3, script.ChainParams.Compressor.ThresholdDB)
	}
	for _, move := range script.Moves {
		if capped := CapSectionMove(script.ChainParams, move); !sameMovePoints(capped, move) {
			t.Fatalf("move %s exceeds MUB-5 caps", move.ID)
		}
	}
	t.Logf("| %s | %s | %+.2f LU | %+.2f dB | %.2f dBTP | %.2f dB (threshold %.1f) | %.2f dB | %+.1f dB%s |", name, profile, rise, -cut, prediction.AfterMetrics.TruePeakDBTP, prediction.CompressorAverageGainReductionDB, script.ChainParams.Compressor.ThresholdDB, prediction.LimiterPeakGainReductionDB, match.GainDB, map[bool]string{true: " (limiting cap)"}[match.LimiterCapped])
}

func sameMovePoints(a, b automation.Move) bool {
	if len(a.Points) != len(b.Points) {
		return false
	}
	for i := range a.Points {
		if a.Points[i] != b.Points[i] {
			return false
		}
	}
	return true
}

// Legacy v1 scripts carry the same visible explanation for large changes.
func TestLegacyScriptsExplainLargeLoudnessChanges(t *testing.T) {
	buf := referenceMix(4, false)
	script, err := AnalyzeDeep(context.Background(), buf, ProfilePunchyCommercial, nil)
	if err != nil {
		t.Fatal(err)
	}
	if script.CeilingDBTP > MaxStartingCeilingDBTP {
		t.Fatal("legacy script ceiling above -1 dBTP")
	}
	rise := script.AfterMetrics.IntegratedLUFS - script.BeforeMetrics.IntegratedLUFS
	if (rise > MaxUnexplainedLoudnessRiseLU) != hasFinding(script.Findings, "predicted-loudness-increase") {
		t.Fatalf("legacy rise %.2f LU without matching finding %+v", rise, script.Findings)
	}
}

// A clipped, square-like source cannot get louder without more limiting: the
// Level match stops at 2 dB of limiter reduction and the drop finding says why.
// The source peaks at 0.75: since V1-13 the limiter band-limits at 0.45 fs and
// reads the clipped edges' true peaks, so at 0.8 the proposal alone took 2.25
// dB of reduction and left no Level match to cap.
func TestLevelMatchReportsTheLimitingCap(t *testing.T) {
	t.Parallel()
	const rate, seconds = 48000, 2.0
	frames := int(seconds * rate)
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range frames {
		phase := float64(i) / rate
		value := .75 * math.Tanh(8*(math.Sin(2*math.Pi*110*phase)+.5*math.Sin(2*math.Pi*1760*phase)))
		left[i], right[i] = float32(value), float32(value)
	}
	buf := &audio.Buffer{Left: left, Right: right, SampleRate: rate, Channels: 2, Frames: frames, Duration: seconds}
	script, prediction, err := AnalyzeDeepV2Context(context.Background(), buf, ProfilePunchyCommercial, nil)
	if err != nil {
		t.Fatal(err)
	}
	drop := script.BeforeMetrics.IntegratedLUFS - prediction.AfterMetrics.IntegratedLUFS
	if !prediction.LevelMatch.LimiterCapped || drop <= MaxUnexplainedLoudnessRiseLU || !hasFinding(script.Findings, "predicted-loudness-decrease") {
		t.Fatalf("drop %.2f LU, match %+v, findings %+v", drop, prediction.LevelMatch, script.Findings)
	}
	if prediction.LevelMatch.GainDB <= 0 || prediction.LimiterPeakGainReductionDB > MaxLevelMatchLimiterReductionDB || prediction.AfterMetrics.TruePeakDBTP > MaxStartingCeilingDBTP {
		t.Fatalf("limiter %.2f dB, true peak %.2f dBTP", prediction.LimiterPeakGainReductionDB, prediction.AfterMetrics.TruePeakDBTP)
	}
	t.Logf("clipped square: %+.2f LU, %.2f dBTP, limiter %.2f dB, Level match %+.1f dB (needed %+.1f)", -drop, prediction.AfterMetrics.TruePeakDBTP, prediction.LimiterPeakGainReductionDB, prediction.LevelMatch.GainDB, prediction.LevelMatch.NeededDB)
}
