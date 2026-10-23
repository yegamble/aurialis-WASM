// cspell:words RMSDB

package mastering

import (
	"context"
	"fmt"
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// AnalyzeDeepV2Context creates conservative, reviewable proposals from measured source features.
// It reports uncertainty and does not infer instruments, musical roles or lost transients.
func AnalyzeDeepV2Context(ctx context.Context, buf *audio.Buffer, profile ProfileID, onProgress func(int, string)) (*ScriptV2, error) {
	features, err := AnalyzeFeaturesContext(ctx, buf, onProgress)
	if err != nil {
		return nil, err
	}
	canonical, err := NormalizeProfile(string(profile))
	if err != nil {
		return nil, err
	}
	metrics, err := dsp.MeasureStereoContext(ctx, buf.Left, buf.Right, float64(buf.SampleRate))
	if err != nil {
		return nil, err
	}
	params := ProfilePreset(canonical)
	params.AlgorithmVersion = dsp.LegacyAlgorithmVersion
	params.Limiter.TruePeak = false
	params.Repair = dsp.RepairParams{}
	params.Compressor.Topology = dsp.CompOptical
	params.Limiter.CeilingDBTP = math.Min(params.Limiter.CeilingDBTP, -1)
	script := &ScriptV2{Version: "2.0", Source: features.Source, Revision: 1, Profile: canonical, Summary: "Measured spectral-balance proposal; review the explicit baseline before applying. No instrument or musical-role inference.", Sections: features.Sections, Moves: []automation.Move{}, Findings: []Finding{}, ChainParams: params, BeforeMetrics: metrics}
	audible := false
	for _, frame := range features.Frames {
		audible = audible || frame.RMSDB > -90
	}
	frequencies, desired := spectralTrendCorrection(features)
	if len(frequencies) >= 3 && audible {
		fitted, residual, fitErr := fitEQContext(ctx, params, float64(buf.SampleRate), frequencies, desired)
		if fitErr != nil {
			return nil, fitErr
		}
		script.ChainParams = fitted
		script.Findings = append(script.Findings, Finding{ID: "measured-tonal-balance", Severity: "info", Title: "Conservative tonal proposal", Detail: fmt.Sprintf("Five-filter response fitted to 15%% of measured deviations from a smooth log-frequency trend, with regularization and +/-3 dB gain deltas. Residual %.3f dB RMS. This trend is a heuristic, not a target mastering standard.", residual), Lane: "EQ"})
	}
	if features.WindowCrestPercentiles[1] < 6 && audible {
		script.Findings = append(script.Findings, Finding{ID: "measured-low-crest", Severity: "warning", Title: "Low measured crest factor", Detail: "The median one-second crest factor is below 6 dB. Existing dynamics may already be restricted; no transient restoration or additional compression was inferred.", Lane: "Dynamics"})
	}
	for _, section := range script.Sections {
		peakEstimate := -120.0
		for _, frame := range features.Frames {
			if frame.CenterFrame >= section.StartFrame && frame.CenterFrame < section.EndFrame {
				peakEstimate = math.Max(peakEstimate, frame.RMSDB+frame.CrestDB+params.InputGainDB)
			}
		}
		if peakEstimate > -.25 && len(script.Sections) > 1 {
			fade := min(buf.SampleRate/20, int((section.EndFrame-section.StartFrame)/2))
			script.Moves = append(script.Moves, automation.Move{ID: "headroom-" + section.ID, SectionID: section.ID, Reason: fmt.Sprintf("Measured window peak estimate plus proposed input gain is %.2f dBFS; reduce this section by 0.5 dB before the chain. No loudness boost is added.", peakEstimate), Target: "inputGainDb", Operation: "add", Points: []automation.Point{{Frame: section.StartFrame, Value: -.5}, {Frame: section.EndFrame, Value: -.5}}, FadeFrames: fade})
		}
	}
	if _, err := ValidateScriptV2Context(ctx, script, buf.SampleRate); err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(100, "Measured proposal ready for review")
	}
	return script, nil
}

func spectralTrendCorrection(features *AnalysisFeatures) ([]float64, []float64) {
	frequencies, levels := make([]float64, 0, 5), make([]float64, 0, 5)
	for _, band := range features.Bands {
		if band.Valid && band.PowerDB > -100 {
			frequencies = append(frequencies, math.Sqrt(band.LowHz*band.UsableHighHz))
			levels = append(levels, band.DensityDBPerHz)
		}
	}
	if len(frequencies) < 3 {
		return frequencies, nil
	}
	xMean, yMean := 0.0, 0.0
	for i, f := range frequencies {
		xMean += math.Log(f)
		yMean += levels[i]
	}
	xMean /= float64(len(frequencies))
	yMean /= float64(len(frequencies))
	numerator, denominator := 0.0, 0.0
	for i, f := range frequencies {
		x := math.Log(f) - xMean
		numerator += x * (levels[i] - yMean)
		denominator += x * x
	}
	desired := make([]float64, len(frequencies))
	for i, f := range frequencies {
		trend := yMean + numerator/denominator*(math.Log(f)-xMean)
		desired[i] = math.Max(-3, math.Min(3, .15*(trend-levels[i])))
	}
	return frequencies, desired
}

func fitEQContext(ctx context.Context, base dsp.Params, sampleRate float64, frequencies, desired []float64) (dsp.Params, float64, error) {
	result := base
	response := func(params dsp.Params, index int) float64 {
		return dsp.EQResponseDB(sampleRate, frequencies[index], params.EQEnabled, params.Bands) - dsp.EQResponseDB(sampleRate, frequencies[index], base.EQEnabled, base.Bands)
	}
	objective := func(params dsp.Params) float64 {
		total := 0.0
		for i := range frequencies {
			delta := response(params, i) - desired[i]
			total += delta * delta
		}
		for i, band := range params.Bands {
			delta := band.GainDB - base.Bands[i].GainDB
			total += .5 * delta * delta
		}
		return total
	}
	best := objective(result)
	for _, step := range []float64{1, .5, .25, .125} {
		for range 3 {
			if err := ctx.Err(); err != nil {
				return base, 0, err
			}
			for index := range result.Bands {
				if !result.EQEnabled || !result.Bands[index].Enabled || result.Bands[index].Type == dsp.FilterHighPass {
					continue
				}
				for _, direction := range []float64{-1, 1} {
					candidate := result
					value := candidate.Bands[index].GainDB + direction*step
					if math.Abs(value-base.Bands[index].GainDB) > 3 || value < -24 || value > 24 {
						continue
					}
					candidate.Bands[index].GainDB = value
					cost := objective(candidate)
					if cost < best {
						result, best = candidate, cost
					}
				}
			}
		}
	}
	squared := 0.0
	for i := range frequencies {
		delta := response(result, i) - desired[i]
		squared += delta * delta
	}
	residual := 0.0
	if len(frequencies) > 0 {
		residual = math.Sqrt(squared / float64(len(frequencies)))
	}
	return result, residual, nil
}
