package mastering

import (
	"context"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// Compare the chain at two rates after bringing both outputs to the same
// measurement rate. This distinguishes processing dependence from a meter
// rate difference; it does not promise rate-invariant nonlinear processing.
func TestOfflineChainRateDependenceIsMeasuredAtOneDeliveryRate(t *testing.T) {
	const highRate, lowRate, frames = 96000, 48000, 192000
	ctx := context.Background()
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		at := float64(i) / highRate
		envelope := .65 + .35*math.Sin(2*math.Pi*.9*at)
		value := envelope * (.2*math.Sin(2*math.Pi*83*at) + .1*math.Sin(2*math.Pi*1103*at) + .06*math.Sin(2*math.Pi*8501*at) + .04*math.Sin(2*math.Pi*17003*at))
		left[i], right[i] = float32(value), float32(.83*value+.02*math.Sin(2*math.Pi*613*at))
	}
	lowL, lowR, err := dsp.ResampleContext(ctx, left, right, highRate, lowRate)
	if err != nil {
		t.Fatal(err)
	}
	base := dsp.DefaultParams()
	base.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	full := base
	full.InputGainDB = 10
	full.EQEnabled, full.Bands[3].GainDB = true, 3
	full.Compressor.Enabled, full.Compressor.ThresholdDB, full.Compressor.Ratio = true, -18, 2
	full.Saturation.Enabled, full.Saturation.Character, full.Saturation.Amount = true, dsp.SatTube, 50
	full.Stereo.Enabled, full.Stereo.MonoBass, full.Stereo.WidthPct = true, true, 120
	full.Limiter.Enabled, full.Limiter.TruePeak, full.Limiter.CeilingDBTP = true, true, -1
	cases := []struct {
		name   string
		params dsp.Params
	}{{"neutral", base}}
	for _, name := range []string{"EQ", "compressor", "saturation", "stereo", "limiter", "full"} {
		params := base
		switch name {
		case "EQ":
			params.EQEnabled, params.Bands = full.EQEnabled, full.Bands
		case "compressor":
			params.Compressor = full.Compressor
		case "saturation":
			params.Saturation = full.Saturation
		case "stereo":
			params.Stereo = full.Stereo
		case "limiter":
			params.InputGainDB, params.Limiter = full.InputGainDB, full.Limiter
		case "full":
			params = full
		}
		cases = append(cases, struct {
			name   string
			params dsp.Params
		}{name, params})
	}
	observed := false
	for _, tc := range cases {
		highL, highR, _, renderErr := dsp.RenderBufferContext(ctx, left, right, highRate, tc.params)
		if renderErr != nil {
			t.Fatal(renderErr)
		}
		highL, highR, renderErr = dsp.ResampleContext(ctx, highL, highR, highRate, lowRate)
		if renderErr != nil {
			t.Fatal(renderErr)
		}
		_, _, low, renderErr := dsp.RenderBufferContext(ctx, lowL, lowR, lowRate, tc.params)
		if renderErr != nil {
			t.Fatal(renderErr)
		}
		high, measureErr := dsp.MeasureStereoContext(ctx, highL, highR, lowRate)
		if measureErr != nil {
			t.Fatal(measureErr)
		}
		delta := low.IntegratedLUFS - high.IntegratedLUFS
		if math.IsNaN(delta) || math.IsInf(delta, 0) {
			t.Fatal("nonfinite comparison", tc.name)
		}
		if tc.name == "neutral" && math.Abs(delta) > .001 {
			t.Fatalf("the comparison itself changed level by %+.6f LU", delta)
		}
		observed = observed || tc.name != "neutral" && math.Abs(delta) > .001
		t.Logf("%s: 48 kHz minus 96 kHz rendered/downsampled = %+.5f LU, crest %+.5f dB", tc.name, delta, low.DynamicRangeDB-high.DynamicRangeDB)
	}
	if !observed {
		t.Fatal("the fixture no longer exercises the documented rate dependence")
	}
}
