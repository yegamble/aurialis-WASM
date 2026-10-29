package mastering

import (
	"context"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestOversampledProposalPredictsItsSelectedExport(t *testing.T) {
	buf, _ := scriptFixture(t)
	script, prediction, err := AnalyzeDeepV2QualityContext(context.Background(), buf, ProfileWarmAnalog, "oversampled", nil)
	if err != nil {
		t.Fatal(err)
	}
	if script.ChainParams.AlgorithmVersion != dsp.OversampledAlgorithmVersion || exportScriptV2(script).ChainParams.AlgorithmVersion != dsp.OversampledAlgorithmVersion {
		t.Fatal("quality was lost between proposal and export")
	}
	_, _, want, err := RenderScriptV2Context(context.Background(), buf, exportScriptV2(script))
	if err != nil {
		t.Fatal(err)
	}
	if prediction.AfterMetrics != want {
		t.Fatal("prediction describes a different rendering algorithm")
	}
	_, classic := scriptFixture(t)
	if exportScriptV2(classic).ChainParams.AlgorithmVersion != dsp.TruePeakAlgorithmVersion {
		t.Fatal("old proposal changed export algorithm")
	}
	for _, quality := range []string{"unknown", "3", "Oversampled"} {
		if _, _, err := AnalyzeDeepV2QualityContext(context.Background(), nil, ProfileWarmAnalog, quality, nil); err == nil {
			t.Fatalf("invalid quality %q was accepted", quality)
		}
	}
}
