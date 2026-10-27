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
	limited := &ProposalPrediction{LevelMatch: LevelMatch{GainDB: 0.4, NeededDB: 2.9, CeilingLimited: true}}
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
		{"ceiling", dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, limited, []string{"predicted-loudness-decrease"}},
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
	// A ceiling-limited drop names the gain it needed and the gain the ceiling allowed.
	if detail := predictionFindings(before, dsp.Metrics{IntegratedLUFS: -18.5, DynamicRangeDB: 15}, limited)[0].Detail; !strings.Contains(detail, "+2.9 dB") || !strings.Contains(detail, "+0.4 dB") || !strings.Contains(detail, "−1 dBTP ceiling") {
		t.Fatal("ceiling-limited drop does not explain the ceiling:", detail)
	}
	if findings := predictionFindings(dsp.Metrics{IntegratedLUFS: -120}, dsp.Metrics{IntegratedLUFS: -60, DynamicRangeDB: 0}, nil); len(findings) != 0 {
		t.Fatal("silent source fabricated findings")
	}
}

// R1: the Level match gain restores the measured shortfall unless the
// prediction's true peak leaves less headroom below the ceiling.
func TestLevelMatchHoldsLoudnessWithinCeilingHeadroom(t *testing.T) {
	for _, tc := range []struct {
		name                string
		beforeLUFS, afterLU float64
		afterTP             float64
		want                LevelMatch
	}{
		{"restores", -16, -18.04, -9, LevelMatch{GainDB: 2, NeededDB: 2.04}},
		{"lowers", -16, -14.5, -3, LevelMatch{GainDB: -1.5, NeededDB: -1.5}},
		{"tiny", -16, -16.04, -3, LevelMatch{GainDB: 0, NeededDB: 0.04}},
		{"ceiling", -10, -13, -2.25, LevelMatch{GainDB: 1.1, NeededDB: 3, CeilingLimited: true}},
		{"at ceiling", -8, -9.5, -1.05, LevelMatch{GainDB: 0, NeededDB: 1.5, CeilingLimited: true}},
		{"capped", -20, -40, -30, LevelMatch{GainDB: MaxLevelMatchGainDB, NeededDB: 20, CeilingLimited: false}},
	} {
		got := levelMatchFor(dsp.Metrics{IntegratedLUFS: tc.beforeLUFS}, dsp.Metrics{IntegratedLUFS: tc.afterLU, TruePeakDBTP: tc.afterTP}, -1)
		if math.Abs(got.GainDB-tc.want.GainDB) > 1e-9 || math.Abs(got.NeededDB-tc.want.NeededDB) > 1e-9 || got.CeilingLimited != tc.want.CeilingLimited {
			t.Fatalf("%s: %+v, want %+v", tc.name, got, tc.want)
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
	fixtures := []struct {
		name string
		buf  *audio.Buffer
	}{{"dynamic", referenceMix(6, false)}, {"dense", referenceMix(6, true)}}
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
	exported := script.Clone()
	exported.ChainParams.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	exported.ChainParams.Limiter.TruePeak = true
	_, _, measured, err := RenderScriptV2Context(ctx, buf, exported)
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
	// Chair ruling: loudness holds within 1 LU, or a finding says the ceiling prevented it.
	if math.Abs(rise) > MaxUnexplainedLoudnessRiseLU && !(rise < 0 && match.CeilingLimited && hasFinding(script.Findings, "predicted-loudness-decrease")) {
		t.Fatalf("Δ LUFS %+.2f LU without a ceiling explanation; level match %+v", rise, match)
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
	t.Logf("| %s | %s | %+.2f LU | %+.2f dB | %.2f dBTP | %.2f dB (threshold %.1f) | %.2f dB | %+.1f dB%s |", name, profile, rise, -cut, prediction.AfterMetrics.TruePeakDBTP, prediction.CompressorAverageGainReductionDB, script.ChainParams.Compressor.ThresholdDB, prediction.LimiterPeakGainReductionDB, match.GainDB, map[bool]string{true: " (ceiling)"}[match.CeilingLimited])
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
