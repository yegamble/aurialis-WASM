package mastering

import (
	"context"
	"errors"
	"strconv"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// ErrExportTooLong rejects a conversion whose output would exceed the decoded-frame bound.
var ErrExportTooLong = errors.New("the converted export would exceed the track length limit; choose a lower sample rate")

// ExportOptions selects delivery conversion after mastering. SampleRate 0 keeps
// the source rate; NoDither leaves 16/24-bit output undithered.
type ExportOptions struct {
	SampleRate int
	NoDither   bool
}

// ErrInvalidSampleRate rejects a sampleRate form value that is not the exact
// decimal of a supported export rate.
var ErrInvalidSampleRate = errors.New("sampleRate must be 44100, 48000, 88200 or 96000")

// ParseExportSampleRate parses the optional sampleRate form value. Only the
// canonical decimal of a supported rate is accepted (no sign, leading zeros or
// whitespace); empty keeps the source rate and returns 0.
func ParseExportSampleRate(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	for _, rate := range dsp.ExportSampleRates {
		if raw == strconv.Itoa(rate) {
			return rate, nil
		}
	}
	return 0, ErrInvalidSampleRate
}

// ParseExportOptions validates the optional sampleRate and dither form values.
func ParseExportOptions(sampleRate int, dither string) (ExportOptions, error) {
	if sampleRate != 0 && !dsp.IsExportSampleRate(sampleRate) {
		return ExportOptions{}, ErrInvalidSampleRate
	}
	switch dither {
	case "", "tpdf":
		return ExportOptions{SampleRate: sampleRate}, nil
	case "none":
		return ExportOptions{SampleRate: sampleRate, NoDither: true}, nil
	default:
		return ExportOptions{}, errors.New("dither must be tpdf or none")
	}
}

// Converts reports whether the export changes the source sample rate.
func (o ExportOptions) Converts(sourceRate int) bool {
	return o.SampleRate != 0 && o.SampleRate != sourceRate
}

// RenderDitherBits is the engine dither for a render. A converted export
// renders undithered and dithers once, after conversion.
func (o ExportOptions) RenderDitherBits(sourceRate, bitDepth int) int {
	if o.NoDither || o.Converts(sourceRate) || (bitDepth != 16 && bitDepth != 24) {
		return 0
	}
	return bitDepth
}

// Validate rejects, before any rendering, a conversion that cannot be
// delivered: output beyond the decoded-frame bound, or a rate ratio too
// complex to convert exactly.
func (o ExportOptions) Validate(frames, sourceRate int) error {
	if !o.Converts(sourceRate) {
		return nil
	}
	if int64(frames)*int64(o.SampleRate) > int64(audio.MaxDecodedFrames)*int64(sourceRate) {
		return ErrExportTooLong
	}
	return dsp.ValidateResampleRates(sourceRate, o.SampleRate)
}

// ConvertExportContext resamples rendered audio to the requested rate, then
// finishes it there (true-peak limiting when the limiter is enabled, then the
// requested dither) and measures the delivered audio. Gain reduction adds the
// delivery limiter to the render's. It returns the inputs unchanged when no
// conversion is requested.
func ConvertExportContext(ctx context.Context, left, right []float32, sourceRate, bitDepth int, params dsp.Params, rendered dsp.Metrics, o ExportOptions) ([]float32, []float32, dsp.Metrics, int, error) {
	if !o.Converts(sourceRate) {
		return left, right, rendered, sourceRate, nil
	}
	if err := o.Validate(len(left), sourceRate); err != nil {
		return nil, nil, dsp.Metrics{}, 0, err
	}
	outL, outR, err := dsp.ResampleContext(ctx, left, right, sourceRate, o.SampleRate)
	if err != nil {
		return nil, nil, dsp.Metrics{}, 0, err
	}
	final := params
	final.DitherBits = 0
	if !o.NoDither && (bitDepth == 16 || bitDepth == 24) {
		final.DitherBits = bitDepth
	}
	deliveryReductionDB, err := dsp.FinishResampled(ctx, outL, outR, float64(o.SampleRate), final)
	if err != nil {
		return nil, nil, dsp.Metrics{}, 0, err
	}
	metrics, err := dsp.MeasureStereoContext(ctx, outL, outR, float64(o.SampleRate))
	if err != nil {
		return nil, nil, dsp.Metrics{}, 0, err
	}
	metrics.GainReductionDB = rendered.GainReductionDB + deliveryReductionDB
	return outL, outR, metrics, o.SampleRate, nil
}
