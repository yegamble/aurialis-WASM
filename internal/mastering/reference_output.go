package mastering

import (
	"context"
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// Repeated deterministic float64 measurements use the same band order and FFT.
// This allowance covers arithmetic noise far below any acoustic accuracy claim.
const referenceOutputResidualToleranceDB = 1e-9

func referenceOutputResidual(bands [5]ReferenceBand, measured, reference [5]float64) float64 {
	measuredTotal, referenceTotal, weights := 0.0, 0.0, 0.0
	for i, band := range bands {
		if band.Included {
			measuredTotal += measured[i]
			referenceTotal += reference[i]
			weights += math.Log(band.HighHz / band.LowHz)
		}
	}
	if weights == 0 {
		return 0
	}
	if measuredTotal <= 0 || referenceTotal <= 0 {
		return 300
	}
	levelDifference := 10 * math.Log10(referenceTotal/measuredTotal)
	total := 0.0
	for i, band := range bands {
		if !band.Included {
			continue
		}
		delta := 10*math.Log10(math.Max(1e-30, reference[i])/math.Max(1e-30, measured[i])) - levelDifference
		total += math.Log(band.HighHz/band.LowHz) * delta * delta
	}
	return math.Sqrt(total / weights)
}

func halveReferenceDelta(baseline, candidate dsp.Params) dsp.Params {
	for i := range candidate.Bands {
		candidate.Bands[i].GainDB = baseline.Bands[i].GainDB + .5*(candidate.Bands[i].GainDB-baseline.Bands[i].GainDB)
	}
	candidate.Stereo.WidthPct = baseline.Stereo.WidthPct + .5*(candidate.Stereo.WidthPct-baseline.Stereo.WidthPct)
	return candidate
}

// Every candidate is re-rendered through the complete immutable chain. The exact
// baseline is the fallback; only already-permitted EQ/width deltas are reduced.
func guardReferenceOutputContext(ctx context.Context, source *audio.Buffer, result *ReferenceProposal, candidate dsp.Params, baselinePower, referencePower [5]float64, edges [6]float64) (dsp.Params, [5]float64, error) {
	if candidate == result.Baseline {
		return candidate, baselinePower, nil
	}
	if result.Options.ProtectBelowHz > 0 && baselinePower[0] < 1e-12 {
		result.Warnings = append(result.Warnings, "Rendered bass is below the measurement floor; protected matching retains the original chain.")
		return result.Baseline, baselinePower, nil
	}
	for attempt := range 8 {
		if err := ctx.Err(); err != nil {
			return result.Baseline, baselinePower, err
		}
		boost, protected := referenceResponseBounds(result, candidate, float64(source.SampleRate), 401)
		if boost <= 3 && protected <= .25 {
			measured, err := renderedReferenceSpectrumContext(ctx, source, candidate, edges)
			if err != nil {
				return result.Baseline, baselinePower, err
			}
			bassPass := result.Options.ProtectBelowHz == 0 || math.Abs(10*math.Log10(math.Max(measured[0], 1e-30)/baselinePower[0])) <= .25
			residual := referenceOutputResidual(result.Bands, measured, referencePower)
			if bassPass && residual <= result.BeforeOutputResidualDB+referenceOutputResidualToleranceDB {
				if attempt > 0 {
					result.Warnings = append(result.Warnings, "Full-chain output verification reduced the proposed EQ/width changes to preserve tonal error and protected bass limits.")
				}
				return candidate, measured, nil
			}
		}
		candidate = halveReferenceDelta(result.Baseline, candidate)
	}
	result.Warnings = append(result.Warnings, "The proposed full-chain output failed tonal or bass verification; the complete original chain was retained.")
	return result.Baseline, baselinePower, nil
}
