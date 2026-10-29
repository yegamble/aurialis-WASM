package browserjobs_test

import (
	"encoding/json"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func TestBrowserProposalCarriesExplicitQuality(t *testing.T) {
	result := run(t, browserjobs.Request{Operation: "deep", ScriptVersion: "2.0", RenderQuality: "oversampled"}, source(t), nil)
	var response struct {
		Script     *mastering.ScriptV2           `json:"scriptV2"`
		Prediction *mastering.ProposalPrediction `json:"prediction"`
	}
	if err := json.Unmarshal(result.Metadata, &response); err != nil {
		t.Fatal(err)
	}
	if response.Script == nil || response.Script.ChainParams.AlgorithmVersion != 3 || response.Prediction == nil {
		t.Fatal("browser proposal lost requested quality")
	}
	for _, raw := range []string{
		`{"operation":"deep","scriptVersion":"2.0","renderQuality":"invalid"}`,
		`{"operation":"deep","renderQuality":"oversampled"}`,
		`{"operation":"render","renderQuality":"oversampled"}`,
		`{"operation":"deep","scriptVersion":"2.0","renderQuality":null}`,
	} {
		if _, err := browserjobs.DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
