package mastering

import (
	"context"
	"errors"
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// ReferenceWidth reports a conservative optional proposal, not a recreated stereo image.
type ReferenceWidth struct {
	SourceSideMidDB     float64 `json:"sourceSideMidDb"`
	ReferenceSideMidDB  float64 `json:"referenceSideMidDb"`
	BeforeSideMidDB     float64 `json:"beforeSideMidDb"`
	AfterSideMidDB      float64 `json:"afterSideMidDb"`
	BeforeCorrelation   float64 `json:"beforeCorrelation"`
	AfterCorrelation    float64 `json:"afterCorrelation"`
	BeforeWidthPct      float64 `json:"beforeWidthPct"`
	AfterWidthPct       float64 `json:"afterWidthPct"`
	AfterSamplePeakDBFS float64 `json:"afterSamplePeakDbfs"`
	Applied             bool    `json:"applied"`
	Reason              string  `json:"reason"`
}

type stereoMoments struct {
	frames                                               int
	meanL, meanR, varianceL, varianceR, covariance, peak float64
}

func (moments *stereoMoments) add(left, right float64) {
	moments.frames++
	count := float64(moments.frames)
	deltaL, deltaR := left-moments.meanL, right-moments.meanR
	moments.meanL += deltaL / count
	moments.meanR += deltaR / count
	moments.varianceL += deltaL * (left - moments.meanL)
	moments.varianceR += deltaR * (right - moments.meanR)
	moments.covariance += deltaL * (right - moments.meanR)
	moments.peak = math.Max(moments.peak, math.Max(math.Abs(left), math.Abs(right)))
}
func (moments stereoMoments) powers() (float64, float64) {
	if moments.frames < 2 {
		return 0, 0
	}
	divisor := 4 * float64(moments.frames)
	return math.Max(0, (moments.varianceL+moments.varianceR+2*moments.covariance)/divisor), math.Max(0, (moments.varianceL+moments.varianceR-2*moments.covariance)/divisor)
}
func (moments stereoMoments) sideMidDB() float64 {
	mid, side := moments.powers()
	return ratioDB(side, mid)
}
func (moments stereoMoments) correlation() float64 {
	if moments.varianceL <= 1e-20 && moments.varianceR <= 1e-20 {
		return 1
	}
	if moments.varianceL <= 1e-20 || moments.varianceR <= 1e-20 {
		return 0
	}
	return math.Max(-1, math.Min(1, moments.covariance/math.Sqrt(moments.varianceL*moments.varianceR)))
}
func sourceStereoMoments(ctx context.Context, source *audio.Buffer) (stereoMoments, error) {
	var moments stereoMoments
	for i, left := range source.Left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return moments, err
			}
		}
		moments.add(float64(left), float64(source.Right[i]))
	}
	return moments, nil
}
func renderedStereoMoments(ctx context.Context, source *audio.Buffer, params dsp.Params) (stereoMoments, error) {
	var moments stereoMoments
	engine := dsp.NewEngine(float64(source.SampleRate))
	engine.SetParams(params)
	if engine.LatencyFrames() != 0 {
		return moments, errors.New("reference width guard requires zero-buffered-latency algorithm 1")
	}
	var left, right [4096]float32
	for start := 0; start < len(source.Left); start += len(left) {
		if err := ctx.Err(); err != nil {
			return moments, err
		}
		count := min(len(left), len(source.Left)-start)
		engine.ProcessBlock(source.Left[start:start+count], source.Right[start:start+count], left[:count], right[:count])
		for i := range count {
			l, r := float64(left[i]), float64(right[i])
			if !isFinite(l) || !isFinite(r) {
				return moments, errors.New("reference width render produced invalid samples")
			}
			moments.add(l, r)
		}
	}
	return moments, nil
}

func proposeReferenceWidth(ctx context.Context, source, reference *audio.Buffer, result *ReferenceProposal, params dsp.Params) (dsp.Params, *ReferenceWidth, error) {
	original, err := sourceStereoMoments(ctx, source)
	if err != nil {
		return params, nil, err
	}
	referenceMoments, err := sourceStereoMoments(ctx, reference)
	if err != nil {
		return params, nil, err
	}
	before, err := renderedStereoMoments(ctx, source, params)
	if err != nil {
		return params, nil, err
	}
	width := &ReferenceWidth{SourceSideMidDB: original.sideMidDB(), ReferenceSideMidDB: referenceMoments.sideMidDB(), BeforeSideMidDB: before.sideMidDB(), AfterSideMidDB: before.sideMidDB(), BeforeCorrelation: before.correlation(), AfterCorrelation: before.correlation(), BeforeWidthPct: params.Stereo.WidthPct, AfterWidthPct: params.Stereo.WidthPct, AfterSamplePeakDBFS: powerDB(before.peak * before.peak)}
	_, sourceSide := original.powers()
	referenceMid, referenceSide := referenceMoments.powers()
	switch {
	case !params.Stereo.Enabled:
		width.Reason = "Stereo processing is disabled and remains disabled."
	case sourceSide < 1e-12 || referenceMid+referenceSide < 1e-12 || params.Stereo.WidthPct == 0:
		width.Reason = "Insufficient stereo energy for a width proposal; no missing stereo information was invented."
	case before.correlation() < .1 || referenceMoments.correlation() < 0:
		width.Reason = "Current or reference correlation is unsuitable for an automatic width proposal."
	default:
		target := params.Stereo.WidthPct * math.Pow(10, (referenceMoments.sideMidDB()-before.sideMidDB())/20)
		span := 20 * result.Options.Amount
		target = math.Max(math.Max(0, params.Stereo.WidthPct-span), math.Min(math.Min(200, params.Stereo.WidthPct+span), target))
		candidate := params
		candidate.Stereo.WidthPct = target
		after, measureErr := renderedStereoMoments(ctx, source, candidate)
		if measureErr != nil {
			return params, nil, measureErr
		}
		if after.correlation() < .1 {
			width.Reason = "Proposed width failed the measured correlation guard; the original width was retained."
			return params, width, nil
		}
		width.Reason = "Width proposal is capped at 20 percentage points times match amount and checked on rendered output; residual stereo differences remain."
		return candidate, width, nil
	}
	return params, width, nil
}

func finalizeReferenceWidth(ctx context.Context, source *audio.Buffer, result *ReferenceProposal, params dsp.Params) (dsp.Params, error) {
	after, err := renderedStereoMoments(ctx, source, params)
	if err != nil {
		return params, err
	}
	if params.Stereo.WidthPct != result.Baseline.Stereo.WidthPct && after.correlation() < .1 {
		result.Width.Reason = "Final width/correlation guard failed after protection; the complete original chain was retained."
		params = result.Baseline
		after, err = renderedStereoMoments(ctx, source, params)
		if err != nil {
			return params, err
		}
		result.RemeasuredProtectedDeltaDB = 0
	}
	result.Width.AfterSideMidDB = after.sideMidDB()
	result.Width.AfterCorrelation = after.correlation()
	result.Width.AfterWidthPct = params.Stereo.WidthPct
	result.Width.AfterSamplePeakDBFS = powerDB(after.peak * after.peak)
	result.Width.Applied = params.Stereo.WidthPct != result.Baseline.Stereo.WidthPct
	return params, nil
}
