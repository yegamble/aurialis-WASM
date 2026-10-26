package browserjobs

import (
	"context"
	"errors"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func render(ctx context.Context, request Request, buf *audio.Buffer) (*Result, error) {
	params := dsp.DefaultParams()
	var script *mastering.ScriptV2
	var err error
	if request.Script != "" {
		if request.Params != "" || request.Profile != "" {
			return nil, errors.New("script is mutually exclusive with params and profile")
		}
		script, err = mastering.DecodeScriptV2([]byte(request.Script))
		if err != nil {
			return nil, err
		}
		params = script.ChainParams
	}
	if request.Profile != "" {
		profile, profileErr := mastering.NormalizeProfile(request.Profile)
		if profileErr != nil {
			return nil, profileErr
		}
		params = mastering.ProfilePreset(profile)
	}
	if request.Params != "" {
		params, err = dsp.DecodeParamsJSON([]byte(request.Params), params)
		if err != nil {
			return nil, err
		}
	}
	if err := dsp.ValidateParams(params); err != nil {
		return nil, err
	}
	bits := request.BitDepth
	if bits == 0 {
		bits = 24
	}
	if bits != 16 && bits != 24 && bits != 32 {
		return nil, errors.New("bitDepth must be 16, 24 or 32")
	}
	if request.Format != "" && request.Format != "json" {
		return nil, errors.New("unsupported local render format")
	}
	export, err := mastering.ParseExportOptions(request.SampleRate, request.Dither)
	if err != nil {
		return nil, err
	}
	if err := export.Validate(len(buf.Left), buf.SampleRate); err != nil {
		return nil, err
	}
	params.DitherBits = export.RenderDitherBits(buf.SampleRate, bits)
	if script != nil {
		script.ChainParams = params
	}
	before, err := dsp.MeasureStereoContext(ctx, buf.Left, buf.Right, float64(buf.SampleRate))
	if err != nil {
		return nil, err
	}
	left, right, after := buf.Left, buf.Right, before
	if script != nil || !params.Bypass {
		if script != nil {
			left, right, after, err = mastering.RenderScriptV2Context(ctx, buf, script)
		} else {
			left, right, after, err = dsp.RenderBufferContext(ctx, buf.Left, buf.Right, float64(buf.SampleRate), params)
		}
		if err != nil {
			return nil, err
		}
	}
	left, right, after, rate, err := mastering.ConvertExportContext(ctx, left, right, buf.SampleRate, bits, params, after, export)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{"status": "ok", "sampleRate": rate, "frames": len(left), "duration": float64(len(left)) / float64(rate), "bitDepth": bits, "params": params, "beforeMetrics": before, "afterMetrics": after}
	if request.Format == "json" {
		return metadata(fields)
	}
	if params.Bypass && bits == 32 && rate == buf.SampleRate {
		identity, identityErr := mastering.SourceIdentityContext(ctx, buf)
		if identityErr != nil {
			return nil, identityErr
		}
		fields["sourceIdentity"] = identity
	}
	result, err := metadata(fields)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result.Audio, err = audio.EncodeWAV(left, right, rate, bits)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
