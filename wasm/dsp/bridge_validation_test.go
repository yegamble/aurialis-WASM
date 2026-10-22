package main

import (
	"math"
	"testing"
)

func TestJSONBandRejectionPreservesEngineHistory(t *testing.T) {
	bridge := NewBridge(48000)
	params := bridge.Params()
	params.Bands[2].GainDB = 3
	params.Compressor.Ratio = 4
	params.Compressor.ThresholdDB = -24
	params.Saturation.Amount = 25
	bridge.SetParams(params)
	input, output := make([]float32, 128), make([]float32, 128)
	for i := range input {
		input[i] = float32(0.2 * math.Sin(float64(i)*0.1))
	}
	bridge.ProcessBlock(input, input, output, output)
	before := *bridge.engine
	for _, payload := range []string{
		`{"Bands":[]}`, `{"BANDS":[null,null,null,null,null]}`,
		`{"Multiband":{"Bands":[]}}`,
		`{"multiband":{"BANDS":[{"ratio":2},{"ratio":2},{"ratio":2}]}}`,
	} {
		if err := bridge.SetParamsJSON(payload); err == nil {
			t.Fatalf("accepted malformed band update: %s", payload)
		}
		if *bridge.engine != before {
			t.Fatalf("rejected update changed parameters or DSP history: %s", payload)
		}
	}
}
