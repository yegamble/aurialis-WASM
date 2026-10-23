package mastering

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func renderReferenceTest(t *testing.T, source *audio.Buffer, params dsp.Params) *audio.Buffer {
	t.Helper()
	output := *source
	output.Left, output.Right = make([]float32, source.Frames), make([]float32, source.Frames)
	engine := dsp.NewEngine(float64(source.SampleRate))
	engine.SetParams(params)
	engine.ProcessBlock(source.Left, source.Right, output.Left, output.Right)
	return &output
}

// Lock-in amplitudes after settling are independent of the overlapping Fourier measurement and
// fit's band-center response approximation. All five tones have known frequency.
func toneReferenceMismatch(source, output *audio.Buffer) float64 {
	amplitude := func(samples []float32, frequency float64) float64 {
		var realPart, imaginaryPart float64
		start := source.SampleRate / 10
		for i := start; i < len(samples); i++ {
			phase := 2 * math.Pi * frequency * float64(i) / float64(source.SampleRate)
			realPart += float64(samples[i]) * math.Cos(phase)
			imaginaryPart += float64(samples[i]) * math.Sin(phase)
		}
		return 2 * math.Hypot(realPart, imaginaryPart) / float64(len(samples)-start)
	}
	var original, rendered [5]float64
	var originalSum, renderedSum float64
	for i, frequency := range []float64{60, 250, 1000, 2800, 9000} {
		original[i] = math.Pow(amplitude(source.Left, frequency), 2)
		rendered[i] = math.Pow(amplitude(output.Left, frequency), 2)
		originalSum += original[i]
		renderedSum += rendered[i]
	}
	total, weight := 0.0, 0.0
	for i := range original {
		bandWeight := math.Log(spectrumEdges[i+1] / spectrumEdges[i])
		errorDB := 10 * math.Log10((rendered[i]/renderedSum)/(original[i]/originalSum))
		total += bandWeight * errorDB * errorDB
		weight += bandWeight
	}
	return math.Sqrt(total / weight)
}

func TestReferenceMatchesRenderedNonNeutralBaseline(t *testing.T) {
	source := referenceFixture(48000, .01)
	baseline := dsp.DefaultParams()
	baseline.Compressor.Enabled, baseline.Saturation.Enabled, baseline.Limiter.Enabled = false, false, false
	baseline.Bands[0].GainDB, baseline.Bands[4].GainDB = 12, -9
	proposal, err := MatchReferenceContext(context.Background(), source, source, baseline, ReferenceOptions{Amount: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	before := toneReferenceMismatch(source, renderReferenceTest(t, source, baseline))
	after := toneReferenceMismatch(source, renderReferenceTest(t, source, proposal.Params))
	t.Logf("baseline/full output residual %.6f -> %.6f dB; independent settled-tone mismatch %.6f -> %.6f dB", proposal.BeforeOutputResidualDB, proposal.AfterOutputResidualDB, before, after)
	if proposal.SourceSpectrum != "baseline_rendered" || proposal.BeforeOutputResidualDB < 3 || proposal.AfterOutputResidualDB >= proposal.BeforeOutputResidualDB-.5 || after >= before-.5 {
		t.Fatal("existing EQ was ignored or the constrained output fit failed to improve")
	}
	if math.Abs(proposal.BeforeOutputResidualDB-before) > .06 || math.Abs(proposal.AfterOutputResidualDB-after) > .06 {
		t.Fatal("reported output error disagrees with independent tone amplitudes")
	}
	unchanged := proposal.Params
	unchanged.Bands = baseline.Bands
	if unchanged != baseline || proposal.MaxPredictedBoostDB > 3 {
		t.Fatal("matching changed fields outside the allowed bounded EQ gains")
	}
	for i, band := range proposal.Params.Bands {
		if math.Abs(band.GainDB-baseline.Bands[i].GainDB) > 3 {
			t.Fatal("fit exceeded an individual gain delta")
		}
	}
	zero, err := MatchReferenceContext(context.Background(), source, source, baseline, ReferenceOptions{}, nil)
	if err != nil || zero.Params != baseline || zero.BeforeOutputResidualDB != zero.AfterOutputResidualDB || zero.BeforeOutputResidualDB < 3 {
		t.Fatal("amount zero changed processing or hid the existing output mismatch", err)
	}
}

func TestReferenceCompleteNonlinearOutputIsRemeasured(t *testing.T) {
	source := referenceFixture(48000, .07)
	baseline := dsp.DefaultParams()
	baseline.InputGainDB = 12
	baseline.Compressor.Enabled = true
	baseline.Compressor.ThresholdDB, baseline.Compressor.Ratio, baseline.Compressor.MakeupDB = -30, 8, 8
	baseline.Saturation.Enabled, baseline.Saturation.Amount = true, 65
	baseline.Bands[0].GainDB, baseline.Bands[4].GainDB = 3, -3
	for _, protect := range []float64{0, 120} {
		proposal, err := MatchReferenceContext(context.Background(), source, source, baseline, ReferenceOptions{Amount: 1, ProtectBelowHz: protect}, nil)
		if err != nil {
			t.Fatal(err)
		}
		full := renderReferenceTest(t, source, proposal.Params)
		measured, err := referenceSpectrum(context.Background(), full, spectrumEdges)
		if err != nil {
			t.Fatal(err)
		}
		referencePower, err := referenceSpectrum(context.Background(), source, spectrumEdges)
		if err != nil {
			t.Fatal(err)
		}
		actual := referenceOutputResidual(proposal.Bands, measured, referencePower)
		t.Logf("nonlinear protect%g output residual %.6f -> %.6f dB (full render %.6f)", protect, proposal.BeforeOutputResidualDB, proposal.AfterOutputResidualDB, actual)
		if proposal.BeforeOutputResidualDB < .05 || proposal.AfterOutputResidualDB > proposal.BeforeOutputResidualDB+referenceOutputResidualToleranceDB || math.Abs(actual-proposal.AfterOutputResidualDB) > 1e-9 {
			t.Fatal("the actual nonlinear output was not verified")
		}
		if protect > 0 && (proposal.MaxProtectedDeltaDB > .25 || math.Abs(proposal.RemeasuredProtectedDeltaDB) > .25) {
			t.Fatal("output matching bypassed bass protection")
		}
	}
}

func TestReferenceOutputGuardDeclinesEveryWorseningCandidate(t *testing.T) {
	source := referenceFixture(48000, .02)
	baseline := dsp.DefaultParams()
	result, err := MatchReferenceContext(context.Background(), source, source, baseline, ReferenceOptions{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	powers, err := renderedReferenceSpectrumContext(context.Background(), source, baseline, spectrumEdges)
	if err != nil {
		t.Fatal(err)
	}
	referencePower, err := referenceSpectrum(context.Background(), source, spectrumEdges)
	if err != nil {
		t.Fatal(err)
	}
	candidate := baseline
	candidate.Bands[2].GainDB = 2
	accepted, finalPower, err := guardReferenceOutputContext(context.Background(), source, result, candidate, powers, referencePower, spectrumEdges)
	if err != nil || accepted != baseline || finalPower != powers {
		t.Fatal("a correction to an already matched source worsened its output", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := guardReferenceOutputContext(ctx, source, result, candidate, powers, referencePower, spectrumEdges); !errors.Is(err, context.Canceled) {
		t.Fatal("output verification ignored cancellation", err)
	}
}

func TestReferenceOutputNoEnergyDisabledAndCancellation(t *testing.T) {
	silence := featureSignal(8000, .01, func(int) (float32, float32) { return 0, 0 })
	proposal, err := MatchReferenceContext(context.Background(), silence, silence, dsp.DefaultParams(), ReferenceOptions{Amount: 1}, nil)
	if err != nil || proposal.Params != dsp.DefaultParams() || proposal.BeforeOutputResidualDB != 0 || proposal.AfterOutputResidualDB != 0 {
		t.Fatal("no-energy output produced invented mismatch or processing", err)
	}
	source := referenceFixture(48000, .02)
	baseline := dsp.DefaultParams()
	baseline.EQEnabled = false
	baseline.Saturation.Enabled, baseline.Saturation.Amount = true, 60
	proposal, err = MatchReferenceContext(context.Background(), source, source, baseline, ReferenceOptions{Amount: 1}, nil)
	if err != nil || proposal.Params != baseline || proposal.AfterOutputResidualDB != proposal.BeforeOutputResidualDB {
		t.Fatal("disabled EQ was enabled or its output changed", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err = MatchReferenceContext(ctx, source, source, dsp.DefaultParams(), ReferenceOptions{Amount: 1}, func(progress int, _ string) {
		if progress == 65 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatal("matching ignored cancellation after baseline measurement", err)
	}
}

// The response guard is challenged through actual steady-state DSP rather than
// comparing two searches of the same response function.
func TestReferenceAcceptedHighQSumThroughActualDSP(t *testing.T) {
	baseline := dsp.DefaultParams()
	baseline.Compressor.Enabled, baseline.Saturation.Enabled, baseline.Limiter.Enabled = false, false, false
	for i := range baseline.Bands {
		baseline.Bands[i].Enabled = false
	}
	for i := range 2 {
		baseline.Bands[i] = dsp.BandParams{FreqHz: 1000 + float64(i)*3, GainDB: 20, Q: 20, Type: dsp.FilterPeaking, Enabled: true}
	}
	result := &ReferenceProposal{Baseline: baseline}
	for i := range result.Bands {
		result.Bands[i] = ReferenceBand{LowHz: spectrumEdges[i], HighHz: spectrumEdges[i+1], Included: true}
	}
	result.Bands[2].TargetDeltaDB = 6
	candidate, err := fitReferenceContext(context.Background(), result, 48000)
	if err != nil {
		t.Fatal(err)
	}
	for _, frequency := range []float64{1000, 1001.5, 1003} {
		source := featureSignal(48000, 3, func(i int) (float32, float32) {
			value := float32(.00001 * math.Sin(2*math.Pi*frequency*float64(i)/48000))
			return value, value
		})
		before, after := renderReferenceTest(t, source, baseline), renderReferenceTest(t, source, candidate)
		var beforePower, afterPower float64
		// Gain-dependent legacy Q has a long decay; settle for two seconds.
		for i := 96000; i < source.Frames; i++ {
			beforePower += float64(before.Left[i]) * float64(before.Left[i])
			afterPower += float64(after.Left[i]) * float64(after.Left[i])
		}
		actual := 10 * math.Log10(afterPower/beforePower)
		predicted := referenceResponseDelta(result, candidate, 48000, frequency)
		if actual > 3.0001 || math.Abs(actual-predicted) > .002 {
			t.Fatalf("actual high-Q summed gain escaped response protection: frequency%g actual%.9g predicted%.9g", frequency, actual, predicted)
		}
	}
}
