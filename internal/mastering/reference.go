package mastering

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"

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
	Version                    string           `json:"version"`
	Source                     SourceIdentity   `json:"source"`
	Reference                  SourceIdentity   `json:"reference"`
	Baseline                   dsp.Params       `json:"baseline"`
	Params                     dsp.Params       `json:"params"`
	Options                    ReferenceOptions `json:"options"`
	Bands                      [5]ReferenceBand `json:"bands"`
	BeforeResidualDB           float64          `json:"beforeResidualDb"`
	FitResidualDB              float64          `json:"fitResidualDb"`
	MaxPredictedBoostDB        float64          `json:"maxPredictedBoostDb"`
	MaxProtectedDeltaDB        float64          `json:"maxProtectedDeltaDb"`
	RemeasuredProtectedDeltaDB float64          `json:"remeasuredProtectedDeltaDb"`
	ProtectionVerified         bool             `json:"protectionVerified"`
	Warnings                   []string         `json:"warnings"`
}

// MatchReferenceContext measures common-band spectra and fits the actual summed TPT response.
// It preserves every non-EQ field, band frequency/Q/type/enable and disabled-module state.
func MatchReferenceContext(ctx context.Context, source, reference *audio.Buffer, baseline dsp.Params, options ReferenceOptions, onProgress func(int, string)) (*ReferenceProposal, error) {
	if err := ValidateReferenceOptions(options); err != nil {
		return nil, err
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
	if options.ProtectBelowHz > 0 && fitted != baseline {
		fitted, result.RemeasuredProtectedDeltaDB, err = protectRenderedReferenceBass(ctx, source, result, fitted, edges)
		if err != nil {
			return nil, err
		}
		result.ProtectionVerified = true
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

// Numerical response protection includes both chains' pole neighborhoods and local
// extrema. Fixed log grids alone can miss a high-Q resonance by several dB.
func referenceResponseBounds(result *ReferenceProposal, params dsp.Params, rate float64, probes int) (float64, float64) {
	high := math.Min(20000, rate*.499)
	frequencies := make([]float64, 0, probes+200)
	for i := range probes {
		frequencies = append(frequencies, 20*math.Pow(high/20, float64(i)/float64(probes-1)))
	}
	frequencies = append(frequencies, dsp.EQResponseAnchors(rate, result.Baseline.Bands)...)
	frequencies = append(frequencies, dsp.EQResponseAnchors(rate, params.Bands)...)
	response := func(frequency float64) float64 { return referenceResponseDelta(result, params, rate, frequency) }
	boost := responseExtremum(frequencies, 20, high, response, false)
	protected := 0.0
	if result.Options.ProtectBelowHz > 0 {
		for i := range probes {
			frequencies = append(frequencies, 20+(result.Options.ProtectBelowHz-20)*float64(i)/float64(probes-1))
		}
		protected = responseExtremum(frequencies, 20, result.Options.ProtectBelowHz, response, true)
	}
	return boost, protected
}

func responseExtremum(frequencies []float64, low, high float64, response func(float64) float64, absolute bool) float64 {
	points := make([]float64, 0, len(frequencies)+2)
	points = append(points, low, high)
	for _, frequency := range frequencies {
		if isFinite(frequency) && frequency > low && frequency < high {
			points = append(points, frequency)
		}
	}
	sort.Float64s(points)
	value := func(frequency float64) float64 {
		measured := response(frequency)
		if absolute {
			return math.Abs(measured)
		}
		return measured
	}
	peak := 0.0
	levels := make([]float64, len(points))
	for i, frequency := range points {
		levels[i] = value(frequency)
		if !isFinite(levels[i]) {
			return math.Inf(1)
		}
		peak = math.Max(peak, levels[i])
	}
	for i := 1; i+1 < len(points); i++ {
		if levels[i] <= levels[i-1] || levels[i] < levels[i+1] {
			continue
		}
		left, right := points[i-1], points[i+1]
		for range 28 {
			a, b := left+(right-left)/3, right-(right-left)/3
			first, second := value(a), value(b)
			if !isFinite(first) || !isFinite(second) {
				return math.Inf(1)
			}
			peak = math.Max(peak, math.Max(first, second))
			if first < second {
				left = a
			} else {
				right = b
			}
		}
	}
	return peak
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

// Protect rendered bass as well as the linear EQ prediction: broadband nonlinear
// stages can change bass level when only a high-frequency contour was requested.
func protectRenderedReferenceBass(ctx context.Context, source *audio.Buffer, result *ReferenceProposal, candidate dsp.Params, edges [6]float64) (dsp.Params, float64, error) {
	baselinePower, err := renderedReferenceBassPower(ctx, source, result.Baseline, edges)
	if err != nil {
		return result.Baseline, 0, err
	}
	if baselinePower < 1e-12 {
		result.Warnings = append(result.Warnings, "Rendered bass is below the measurement floor; protected matching retains the original chain.")
		return result.Baseline, 0, nil
	}
	for range 8 {
		proposedPower, measureErr := renderedReferenceBassPower(ctx, source, candidate, edges)
		if measureErr != nil {
			return result.Baseline, 0, measureErr
		}
		delta := 10 * math.Log10(math.Max(proposedPower, 1e-30)/baselinePower)
		if math.Abs(delta) <= .25 {
			return candidate, delta, nil
		}
		for i := range candidate.Bands {
			candidate.Bands[i].GainDB = result.Baseline.Bands[i].GainDB + .5*(candidate.Bands[i].GainDB-result.Baseline.Bands[i].GainDB)
		}
	}
	result.Warnings = append(result.Warnings, "The nonlinear chain prevented verified bass protection; the original chain was retained.")
	return result.Baseline, 0, nil
}

// ValidateReferenceOptions accepts only the current bounded EQ-only contract.
func ValidateReferenceOptions(options ReferenceOptions) error {
	if !isFinite(options.Amount) || options.Amount < 0 || options.Amount > 1 || !isFinite(options.ProtectBelowHz) || (options.ProtectBelowHz != 0 && options.ProtectBelowHz != 120) {
		return errors.New("amount must be 0..1 and protectBelowHz must be 0 or 120")
	}
	return nil
}

// Clone returns an independent editable snapshot; all parameter and band arrays are values.
func (proposal *ReferenceProposal) Clone() *ReferenceProposal {
	if proposal == nil {
		return nil
	}
	copyProposal := *proposal
	copyProposal.Warnings = append([]string{}, proposal.Warnings...)
	return &copyProposal
}
