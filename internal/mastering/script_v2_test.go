package mastering

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func scriptFixture(t *testing.T) (*audio.Buffer, *ScriptV2) {
	t.Helper()
	left, right := make([]float32, 8000), make([]float32, 8000)
	for i := range left {
		left[i] = float32(.1 * math.Sin(float64(i)*.2))
		right[i] = float32(.1 * math.Cos(float64(i)*.17))
	}
	buf := &audio.Buffer{Left: left, Right: right, SampleRate: 8000, Frames: 8000, Duration: 1}
	source, err := SourceIdentityContext(context.Background(), buf)
	if err != nil {
		t.Fatal(err)
	}
	return buf, &ScriptV2{Version: "2.0", Source: source, Revision: 1, Profile: ProfileDynamicOpen, Summary: "Measured fixture", ChainParams: dsp.DefaultParams(), Sections: []FeatureSection{{ID: "section-1", Name: "Section 1", StartFrame: 0, EndFrame: 8000, RoleHint: "unknown", Confidence: 0}}, Moves: []automation.Move{}, Findings: []Finding{}}
}
func TestScriptV2StrictJSON(t *testing.T) {
	_, script := scriptFixture(t)
	data, err := json.Marshal(script)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeScriptV2(data); err != nil {
		t.Fatal(err)
	}
	raw := string(data)
	for _, bad := range []string{
		strings.Replace(raw, `"version":"2.0"`, `"Version":"2.0"`, 1),
		strings.Replace(raw, `"version":"2.0"`, `"version":"2.0","version":"2.0"`, 1),
		strings.Replace(raw, `"version":"2.0",`, "", 1),
		strings.Replace(raw, `"moves":[]`, `"moves":null`, 1),
		strings.Replace(raw, `"chainParams":{`, `"chainParams":{"unexpected":1,`, 1),
		strings.Replace(raw, `"bands":[`, `"bands":[{},`, 1), raw + `{}`, strings.Repeat(" ", MaxScriptV2Bytes+1),
	} {
		if _, err := DecodeScriptV2([]byte(bad)); err == nil {
			t.Fatal("malformed/ambiguous JSON accepted")
		}
	}
}
func TestScriptV2SourceBindingEmptyIdentityAndInterval(t *testing.T) {
	buf, script := scriptFixture(t)
	ctx := context.Background()
	left, right, _, err := RenderScriptV2Context(ctx, buf, script)
	if err != nil {
		t.Fatal(err)
	}
	oldL, oldR, _, err := dsp.RenderBufferContext(ctx, buf.Left, buf.Right, 8000, script.ChainParams)
	if err != nil {
		t.Fatal(err)
	}
	for i := range left {
		if left[i] != oldL[i] || right[i] != oldR[i] {
			t.Fatal("empty v2 differs from native static PCM")
		}
	}
	script.Moves = []automation.Move{{ID: "arbitrary-unique-id", SectionID: "section-1", Reason: "fixture", Target: "inputGainDb", Operation: "add", Points: []automation.Point{{Frame: 1000, Value: 3}, {Frame: 7000, Value: 3}}, FadeFrames: 400}}
	left, _, _, err = RenderScriptV2Context(ctx, buf, script)
	if err != nil {
		t.Fatal(err)
	}
	if left[4000] == oldL[4000] || left[0] != oldL[0] || left[7999] != oldL[7999] {
		t.Fatal("typed target not confined to interval")
	}
	for _, mutate := range []func(*ScriptV2){func(s *ScriptV2) { s.Source.PCMHash = strings.Repeat("0", 64) }, func(s *ScriptV2) { s.Source.Frames++ }, func(s *ScriptV2) { s.Source.SampleRate = 44100 }, func(s *ScriptV2) { s.Version = "1.0" }, func(s *ScriptV2) { s.Moves[0].Target = "repair.deEssDb" }, func(s *ScriptV2) { s.Sections[0].RoleHint = "chorus" }} {
		_, copyScript := scriptFixture(t)
		copyScript.Moves = append([]automation.Move{}, script.Moves...)
		mutate(copyScript)
		if _, _, _, err := RenderScriptV2Context(ctx, buf, copyScript); err == nil {
			t.Fatal("invalid source/version/target accepted")
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, _, err := RenderScriptV2Context(canceled, buf, script); err == nil {
		t.Fatal("canceled source check ignored")
	}
}
func TestMeasuredProposalsSilenceAndRegularizedEQFit(t *testing.T) {
	buf, _ := scriptFixture(t)
	clear(buf.Left)
	clear(buf.Right)
	script, err := AnalyzeDeepV2Context(context.Background(), buf, ProfileDynamicOpen, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(script.Sections) != 1 || len(script.Moves) != 0 || len(script.Findings) != 0 {
		t.Fatal("silence fabricated decisions")
	}
	base := dsp.DefaultParams()
	frequency := []float64{60, 250, 1000, 4000, 12000}
	target := base
	target.Bands[0].GainDB = 2
	target.Bands[2].GainDB = -1
	target.Bands[4].GainDB = 1
	desired := make([]float64, len(frequency))
	initial := 0.0
	for i, f := range frequency {
		desired[i] = dsp.EQResponseDB(48000, f, true, target.Bands)
		initial += desired[i] * desired[i]
	}
	fitted, residual, err := fitEQContext(context.Background(), base, 48000, frequency, desired)
	if err != nil {
		t.Fatal(err)
	}
	if residual >= math.Sqrt(initial/float64(len(frequency))) {
		t.Fatal("actual-response fit did not improve residual")
	}
	for i, band := range fitted.Bands {
		if math.Abs(band.GainDB-base.Bands[i].GainDB) > 3 {
			t.Fatal("EQ correction cap exceeded")
		}
	}
}

func TestPublicScriptV2ProposalsAvoidUnsupportedProcessing(t *testing.T) {
	buf, _ := scriptFixture(t)
	for _, profile := range []ProfileID{ProfileWarmAnalog, ProfilePunchyCommercial, ProfileDynamicOpen, ProfileVocalForward, ProfileBassHeavy} {
		script, err := AnalyzeDeepV2Context(context.Background(), buf, profile, nil)
		if err != nil {
			t.Fatal(err)
		}
		params := script.ChainParams
		if params.AlgorithmVersion != dsp.LegacyAlgorithmVersion || params.Repair != (dsp.RepairParams{}) || params.Limiter.TruePeak || params.Compressor.Topology != dsp.CompOptical || params.Limiter.CeilingDBTP > -1 {
			t.Fatal("public v2 proposal contains unavailable processing", profile, params)
		}
		legacy := ProfilePreset(profile)
		if !legacy.Repair.Enabled || !legacy.Limiter.TruePeak {
			t.Fatal("public v2 changed legacy v1 presets")
		}
		unsupported := script.Clone()
		unsupported.ChainParams.Repair.Enabled = true
		if _, err := ValidateScriptV2Context(context.Background(), unsupported, 8000); err == nil {
			t.Fatal("unsupported repair accepted")
		}
		unsupported = script.Clone()
		unsupported.ChainParams.Limiter.TruePeak = true
		if _, err := ValidateScriptV2Context(context.Background(), unsupported, 8000); err == nil {
			t.Fatal("unsupported true-peak limiter accepted")
		}
	}
}
