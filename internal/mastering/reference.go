package mastering

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// ReferenceOptions bounds the measured tonal proposal. Amount is a fraction, not percent.
// Width is intentionally absent until its independent audible-output guard is implemented.
type ReferenceOptions struct {
	Amount         float64 `json:"amount"`
	ProtectBelowHz float64 `json:"protectBelowHz"`
}

// ReferenceBand describes identical physical bandwidth in both reconstructed sources.
type ReferenceBand struct {
	LowHz              float64 `json:"lowHz"`
	HighHz             float64 `json:"highHz"`
	SourceDensityDB    float64 `json:"sourceDensityDb"`
	ReferenceDensityDB float64 `json:"referenceDensityDb"`
	TargetDeltaDB      float64 `json:"targetDeltaDb"`
	PredictedDeltaDB   float64 `json:"predictedDeltaDb"`
	Included           bool    `json:"included"`
}

// ReferenceProposal is an EQ-only estimate, not a perceptual match or headroom guarantee.
// Callers must apply from Baseline, never repeatedly compound Params onto the last proposal.
type ReferenceProposal struct {
	Version             string           `json:"version"`
	Source              SourceIdentity   `json:"source"`
	Reference           SourceIdentity   `json:"reference"`
	Baseline            dsp.Params       `json:"baseline"`
	Params              dsp.Params       `json:"params"`
	Options             ReferenceOptions `json:"options"`
	Bands               [5]ReferenceBand `json:"bands"`
	BeforeResidualDB    float64          `json:"beforeResidualDb"`
	FitResidualDB       float64          `json:"fitResidualDb"`
	MaxPredictedBoostDB float64          `json:"maxPredictedBoostDb"`
	MaxProtectedDeltaDB float64          `json:"maxProtectedDeltaDb"`
	Warnings            []string         `json:"warnings"`
}

// MatchReferenceContext measures common-band spectra and fits the actual summed TPT response.
// It preserves every non-EQ field, band frequency/Q/type/enable and disabled-module state.
func MatchReferenceContext(ctx context.Context, source, reference *audio.Buffer, baseline dsp.Params, options ReferenceOptions, onProgress func(int, string)) (*ReferenceProposal, error) {
	if !isFinite(options.Amount) || options.Amount < 0 || options.Amount > 1 || !isFinite(options.ProtectBelowHz) || (options.ProtectBelowHz != 0 && options.ProtectBelowHz != 120) {
		return nil, errors.New("amount must be 0..1 and protectBelowHz must be 0 or 120")
	}
	if err := dsp.ValidateParams(baseline); err != nil {
		return nil, err
	}
	sourceID, err := SourceIdentityContext(ctx, source)
	if err != nil {
		return nil, err
	}
	referenceID, err := SourceIdentityContext(ctx, reference)
	if err != nil {
		return nil, err
	}
	result := &ReferenceProposal{Version: "1.0", Source: sourceID, Reference: referenceID, Baseline: baseline, Params: baseline, Options: options, Warnings: []string{"A five-band EQ estimate cannot establish a perceptual match. Nonlinear dynamics, phase, width and final rendered headroom are not predicted."}}
	edges := spectrumEdges
	commonNyquist := float64(min(source.SampleRate, reference.SampleRate)) / 2
	for i := range edges {
		edges[i] = math.Min(edges[i], commonNyquist)
	}
	if onProgress != nil {
		onProgress(10, "Measuring source and reference over common physical bandwidth...")
	}
	sourceBands, err := referenceSpectrum(ctx, source, edges)
	if err != nil {
		return nil, err
	}
	referenceBands, err := referenceSpectrum(ctx, reference, edges)
	if err != nil {
		return nil, err
	}
	var sourcePower, referencePower float64
	count := 0
	for i := range result.Bands {
		band := ReferenceBand{LowHz: edges[i], HighHz: edges[i+1], SourceDensityDB: featureFloorDB, ReferenceDensityDB: featureFloorDB}
		width := band.HighHz - band.LowHz
		if width > 0 {
			band.SourceDensityDB = 10 * math.Log10(math.Max(1e-30, sourceBands[i]/width))
			band.ReferenceDensityDB = 10 * math.Log10(math.Max(1e-30, referenceBands[i]/width))
			band.Included = powerDB(sourceBands[i]) > -90 && powerDB(referenceBands[i]) > -90
		}
		if band.Included {
			sourcePower += sourceBands[i]
			referencePower += referenceBands[i]
			count++
		} else {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Band %.0f-%.0f Hz excluded: no common bandwidth or insufficient measured energy.", band.LowHz, band.HighHz))
		}
		result.Bands[i] = band
	}
	if count < 3 {
		result.Warnings = append(result.Warnings, "Fewer than three audible common bands: no tonal correction proposed.")
		return result, nil
	}
	levelDifference := powerDB(referencePower) - powerDB(sourcePower)
	for i := range result.Bands {
		band := &result.Bands[i]
		if band.Included {
			band.TargetDeltaDB = options.Amount * math.Max(-6, math.Min(6, band.ReferenceDensityDB-band.SourceDensityDB-levelDifference))
		}
	}
	result.BeforeResidualDB = referenceResidual(result, baseline, float64(source.SampleRate))
	result.FitResidualDB = result.BeforeResidualDB
	if options.Amount == 0 || baseline.Bypass || baseline.ABOriginal || !baseline.EQEnabled {
		if options.Amount > 0 {
			result.Warnings = append(result.Warnings, "EQ or processing is bypassed; its state was preserved and no correction applied.")
		}
		return result, nil
	}
	if onProgress != nil {
		onProgress(65, "Fitting a bounded EQ contour with response protection...")
	}
	fitted, err := fitReferenceContext(ctx, result, float64(source.SampleRate))
	if err != nil {
		return nil, err
	}
	result.Params = fitted
	result.FitResidualDB = referenceResidual(result, fitted, float64(source.SampleRate))
	result.MaxPredictedBoostDB, result.MaxProtectedDeltaDB = referenceResponseBounds(result, fitted, float64(source.SampleRate), 401)
	for i := range result.Bands {
		band := &result.Bands[i]
		if band.Included {
			band.PredictedDeltaDB = referenceResponseDelta(result, fitted, float64(source.SampleRate), math.Sqrt(band.LowHz*band.HighHz))
		}
	}
	if result.MaxPredictedBoostDB > 0 {
		result.Warnings = append(result.Warnings, fmt.Sprintf("The estimated EQ contour can add %.2f dB of gain. Render and remeasure final output; no hidden input-gain or loudness adjustment was added.", result.MaxPredictedBoostDB))
	}
	if onProgress != nil {
		onProgress(100, "Measured EQ proposal ready for review")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func referenceSpectrum(ctx context.Context, buf *audio.Buffer, edges [6]float64) ([5]float64, error) {
	size := 1024
	for size < buf.SampleRate/16 && size < 16384 {
		size *= 2
	}
	_, total, err := measureSpectrumBandsContext(ctx, buf, size, edges)
	powers := total.bands
	for i := range powers {
		powers[i] /= float64(len(buf.Left))
	}
	return powers, err
}

func referenceResponseDelta(result *ReferenceProposal, params dsp.Params, rate, frequency float64) float64 {
	return dsp.EQResponseDB(rate, frequency, params.EQEnabled, params.Bands) - dsp.EQResponseDB(rate, frequency, result.Baseline.EQEnabled, result.Baseline.Bands)
}

func referenceResidual(result *ReferenceProposal, params dsp.Params, rate float64) float64 {
	total, weights := 0.0, 0.0
	for _, band := range result.Bands {
		if !band.Included {
			continue
		}
		weight := math.Log(band.HighHz / band.LowHz)
		delta := referenceResponseDelta(result, params, rate, math.Sqrt(band.LowHz*band.HighHz)) - band.TargetDeltaDB
		total += weight * delta * delta
		weights += weight
	}
	if weights == 0 {
		return 0
	}
	return math.Sqrt(total / weights)
}

func referenceResponseBounds(result *ReferenceProposal, params dsp.Params, rate float64, probes int) (float64, float64) {
	boost, protected := 0.0, 0.0
	high := math.Min(20000, rate*.499)
	for i := range probes {
		frequency := 20 * math.Pow(high/20, float64(i)/float64(probes-1))
		boost = math.Max(boost, referenceResponseDelta(result, params, rate, frequency))
		if result.Options.ProtectBelowHz > 0 {
			frequency = 20 + (result.Options.ProtectBelowHz-20)*float64(i)/float64(probes-1)
			protected = math.Max(protected, math.Abs(referenceResponseDelta(result, params, rate, frequency)))
		}
	}
	return boost, protected
}

func fitReferenceContext(ctx context.Context, result *ReferenceProposal, rate float64) (dsp.Params, error) {
	fitted := result.Baseline
	objective := func(params dsp.Params) float64 {
		residual := referenceResidual(result, params, rate)
		cost := residual * residual
		for i, band := range params.Bands {
			delta := band.GainDB - result.Baseline.Bands[i].GainDB
			cost += .025 * delta * delta
		}
		return cost
	}
	best := objective(fitted)
	for _, step := range []float64{1, .5, .25, .125, .0625} {
		for range 3 {
			if err := ctx.Err(); err != nil {
				return fitted, err
			}
			for i, band := range fitted.Bands {
				if !band.Enabled || band.Type == dsp.FilterHighPass {
					continue
				}
				for _, direction := range []float64{-1, 1} {
					candidate := fitted
					value := candidate.Bands[i].GainDB + direction*step
					if math.Abs(value-result.Baseline.Bands[i].GainDB) > 3 || value < -24 || value > 24 {
						continue
					}
					candidate.Bands[i].GainDB = value
					boost, protected := referenceResponseBounds(result, candidate, rate, 41)
					if boost > 2.8 || protected > .20 {
						continue
					}
					cost := objective(candidate)
					if cost < best {
						fitted, best = candidate, cost
					}
				}
			}
		}
	}
	// A finer final grid is independent of the optimizer's coarse candidate guard.
	for range 16 {
		boost, protected := referenceResponseBounds(result, fitted, rate, 401)
		if boost <= 3 && protected <= .25 {
			return fitted, nil
		}
		for i := range fitted.Bands {
			fitted.Bands[i].GainDB = result.Baseline.Bands[i].GainDB + .75*(fitted.Bands[i].GainDB-result.Baseline.Bands[i].GainDB)
		}
	}
	return result.Baseline, nil
}
