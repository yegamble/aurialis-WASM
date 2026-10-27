package mastering

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

var updateGolden = flag.Bool("update", false, "rewrite testdata golden files")

const exportTransformGolden = "testdata/export-transform.golden.json"

// exportTransformCase is shared with src/lib/__tests__/export-transform.test.ts:
// Go writes it with -update; both layers must map input to export exactly.
type exportTransformCase struct {
	Name   string    `json:"name"`
	Input  *ScriptV2 `json:"input"`
	Export *ScriptV2 `json:"export"`
}

func goldenProposal() *ScriptV2 {
	params := ProposalBaseline(ProfileBassHeavy)
	params.Compressor.ThresholdDB = -18.4
	params.Compressor.MakeupDB = 1.3
	return &ScriptV2{
		Version: "2.0", Source: SourceIdentity{PCMHash: strings.Repeat("c", 64), SampleRate: 48000, Frames: 96000}, Revision: 3, Profile: ProfileBassHeavy,
		Summary:     "Golden proposal shared by the Go prediction and the TypeScript export.",
		Sections:    []FeatureSection{{ID: "section-1", Name: "Section 1", StartFrame: 0, EndFrame: 96000, RoleHint: "unknown", Confidence: 0.5}},
		Moves:       []automation.Move{{ID: "headroom-section-1", SectionID: "section-1", Reason: "Golden trim", Target: "inputGainDb", Operation: "add", Points: []automation.Point{{Frame: 0, Value: -0.5}, {Frame: 96000, Value: -0.5}}, FadeFrames: 2400}},
		Findings:    []Finding{{ID: "measured-tonal-balance", Severity: "info", Title: "Golden", Detail: "Golden finding", Lane: "EQ"}},
		ChainParams: params, BeforeMetrics: dsp.Metrics{IntegratedLUFS: -15, TruePeakDBTP: -2, SamplePeakDBFS: -2.2, DynamicRangeDB: 11},
	}
}

// goldenDitheredProposal carries input dither: the prediction measures the
// render before dither, and the browser leaves dither to the export's bit depth.
func goldenDitheredProposal() *ScriptV2 {
	script := goldenProposal()
	script.Profile = ProfileWarmAnalog
	script.ChainParams = ProposalBaseline(ProfileWarmAnalog)
	script.ChainParams.DitherBits = 16
	script.ChainParams.Compressor.MakeupDB = 0.8
	return script
}

// S5: the Go prediction and the browser export apply the same transform to a
// script, so the predicted levels describe the file the user downloads.
func TestExportTransformMatchesTheSharedGolden(t *testing.T) {
	cases := []exportTransformCase{{Name: "proposal", Input: goldenProposal()}, {Name: "input dither", Input: goldenDitheredProposal()}}
	for i := range cases {
		cases[i].Export = exportScriptV2(cases[i].Input)
	}
	encoded, err := json.MarshalIndent(cases, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if *updateGolden {
		if err := os.WriteFile(exportTransformGolden, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(exportTransformGolden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(golden, encoded) {
		t.Fatalf("Go export transform differs from %s; rerun with -update and the TypeScript parity test", exportTransformGolden)
	}
	for _, c := range cases {
		if c.Input.ChainParams.AlgorithmVersion != dsp.LegacyAlgorithmVersion || c.Input.ChainParams.Limiter.TruePeak || c.Export.ChainParams.DitherBits != 0 {
			t.Fatalf("%s: the export transform mutated its input or kept dither", c.Name)
		}
	}
	if cases[1].Input.ChainParams.DitherBits == 0 {
		t.Fatal("the dither case lost its input dither")
	}
}
