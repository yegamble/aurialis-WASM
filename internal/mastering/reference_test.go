package mastering

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func referenceFixture(rate int, amplitude float64) *audio.Buffer {
	return featureSignal(rate, 1, func(i int) (float32, float32) {
		value := 0.0
		for _, frequency := range []float64{60, 250, 1000, 2800, 9000} {
			if frequency < float64(rate)/2 {
				value += amplitude * math.Sin(2*math.Pi*frequency*float64(i)/float64(rate))
			}
		}
		return float32(value), float32(value * .8)
	})
}

func TestReferenceIdentityLevelAndAmountZero(t *testing.T) {
	for _, level := range []float64{.02, .0001} {
		source := referenceFixture(48000, level)
		reference := referenceFixture(48000, level*2)
		baseline := dsp.DefaultParams()
		baseline.Compressor.MakeupDB = 2
		baseline.Stereo.WidthPct = 117
		result, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if result.Params != baseline || result.FitResidualDB > .0001 {
			t.Fatalf("same-spectrum level shift changed EQ: residual%g params%+v", result.FitResidualDB, result.Params.Bands)
		}
		reference.Right[200] += .02
		result, err = MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{}, nil)
		if err != nil || result.Params != baseline {
			t.Fatal("amount0 not exact baseline", err)
		}
	}
}

func TestReferenceBroadEQFitImprovesAndPreservesNonEQ(t *testing.T) {
	source := referenceFixture(48000, .04)
	shaped := dsp.DefaultParams()
	shaped.Bands[1].GainDB = -2
	shaped.Bands[4].GainDB = 2
	engine := dsp.NewEngine(48000)
	engine.SetParams(shaped)
	reference := referenceFixture(48000, .04)
	engine.ProcessBlock(source.Left, source.Right, reference.Left, reference.Right)
	baseline := dsp.DefaultParams()
	baseline.InputGainDB = 1
	baseline.Compressor.MakeupDB = 2
	baseline.Stereo.WidthPct = 117
	result, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.FitResidualDB >= result.BeforeResidualDB*.8 {
		t.Fatalf("fit did not improve known broad EQ enough: %g -> %g", result.BeforeResidualDB, result.FitResidualDB)
	}
	preserved := result.Params
	preserved.Bands = baseline.Bands
	if preserved != baseline {
		t.Fatal("non-EQ fields changed")
	}
	for i, band := range result.Params.Bands {
		old := baseline.Bands[i]
		if band.FreqHz != old.FreqHz || band.Q != old.Q || band.Type != old.Type || band.Enabled != old.Enabled || math.Abs(band.GainDB-old.GainDB) > 3 {
			t.Fatal("band structural state changed")
		}
	}
	if result.MaxPredictedBoostDB > 3 || len(result.Warnings) == 0 {
		t.Fatal("response boost cap or uncertainty missing")
	}
	repeat, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1}, nil)
	if err != nil || repeat.Params != result.Params {
		t.Fatal("snapshot proposal not deterministic")
	}
	t.Logf("known broad EQ residual %.5f -> %.5f dB", result.BeforeResidualDB, result.FitResidualDB)
}

func TestReferenceCommonPhysicalBandwidthAndUnavailableBands(t *testing.T) {
	source := referenceFixture(48000, .04)
	reference := referenceFixture(8000, .04)
	// Remove source-only HF so the same common physical bands have the same spectrum.
	for i := range source.Left {
		v := .04 * math.Sin(2*math.Pi*9000*float64(i)/48000)
		source.Left[i] -= float32(v)
		source.Right[i] -= float32(v * .8)
	}
	result, err := MatchReferenceContext(context.Background(), source, reference, dsp.DefaultParams(), ReferenceOptions{Amount: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bands[4].Included || result.Bands[3].HighHz != 4000 || result.FitResidualDB > .1 {
		t.Fatalf("common frequency support wrong: %+v residual%g", result.Bands, result.FitResidualDB)
	}
	silence := featureSignal(8000, .01, func(int) (float32, float32) { return 0, 0 })
	result, err = MatchReferenceContext(context.Background(), silence, reference, dsp.DefaultParams(), ReferenceOptions{Amount: 1}, nil)
	if err != nil || result.Params != dsp.DefaultParams() || len(result.Warnings) < 2 {
		t.Fatal("silence produced correction or lost exclusion warning", err)
	}
}

func TestReferenceProtectedBassActualRenderedTones(t *testing.T) {
	for _, rate := range []int{8000, 44100, 48000, 96000, 192000} {
		source := referenceFixture(rate, .04)
		reference := referenceFixture(rate, .04)
		for i := range reference.Left {
			extra := float32(.04 * math.Sin(2*math.Pi*60*float64(i)/float64(rate)))
			reference.Left[i] += extra
			reference.Right[i] += extra * .8
		}
		baseline := dsp.DefaultParams()
		result, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1, ProtectBelowHz: 120}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if result.MaxProtectedDeltaDB > .25 {
			t.Fatal("predicted bass protection failed")
		}
		for _, frequency := range []float64{20, 40, 60, 80, 100, 120} {
			buf := featureSignal(rate, 1, func(i int) (float32, float32) {
				v := float32(.02 * math.Sin(2*math.Pi*frequency*float64(i)/float64(rate)))
				return v, v
			})
			original := dsp.NewEngine(float64(rate))
			original.SetParams(baseline)
			fitted := dsp.NewEngine(float64(rate))
			fitted.SetParams(result.Params)
			oldL, oldR := make([]float32, buf.Frames), make([]float32, buf.Frames)
			newL, newR := make([]float32, buf.Frames), make([]float32, buf.Frames)
			original.ProcessBlock(buf.Left, buf.Right, oldL, oldR)
			fitted.ProcessBlock(buf.Left, buf.Right, newL, newR)
			oldPower, newPower := 0.0, 0.0
			for i := rate / 2; i < buf.Frames; i++ {
				oldPower += float64(oldL[i]) * float64(oldL[i])
				newPower += float64(newL[i]) * float64(newL[i])
			}
			delta := 10 * math.Log10(newPower/oldPower)
			if math.Abs(delta) > .25 {
				t.Fatalf("rate%d bass%gHz audible delta%g", rate, frequency, delta)
			}
		}
	}
}

func TestReferenceValidationCancellationAndDisabledEQ(t *testing.T) {
	source := referenceFixture(8000, .02)
	for _, options := range []ReferenceOptions{{Amount: math.NaN()}, {Amount: math.Inf(1)}, {Amount: -.1}, {Amount: 1.1}, {ProtectBelowHz: 80}} {
		if _, err := MatchReferenceContext(context.Background(), source, source, dsp.DefaultParams(), options, nil); err == nil {
			t.Fatal("invalid options accepted")
		}
	}
	for _, stage := range []int{10, 65, 100} {
		ctx, cancel := context.WithCancel(context.Background())
		_, err := MatchReferenceContext(ctx, source, source, dsp.DefaultParams(), ReferenceOptions{Amount: 1}, func(progress int, _ string) {
			if progress == stage {
				cancel()
			}
		})
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation%d ignored: %v", stage, err)
		}
	}
	disabled := dsp.DefaultParams()
	disabled.EQEnabled = false
	result, err := MatchReferenceContext(context.Background(), source, source, disabled, ReferenceOptions{Amount: 1}, nil)
	if err != nil || result.Params != disabled {
		t.Fatal("disabled EQ mutated", err)
	}
}
