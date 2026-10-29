// Package browserjobs exposes the native audio algorithms without HTTP or file storage.
// Its closed bounded contract is shared by the dedicated browser worker and native tests.
package browserjobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// ABIVersion changes whenever the closed worker request/result contract is incompatible.
const ABIVersion = "1.0"

// MaxInputBytes bounds the combined binary inputs independently of metadata.
const MaxInputBytes = 257 * 1024 * 1024

// MaxMetadataBytes permits one bounded ScriptV2 plus small closed operation fields.
const MaxMetadataBytes = mastering.MaxScriptV2Bytes + 128*1024

// Request contains metadata only. Binary audio is passed separately, never JSON encoded.
type Request struct {
	Operation     string `json:"operation"`
	Params        string `json:"params,omitempty"`
	Script        string `json:"script,omitempty"`
	Profile       string `json:"profile,omitempty"`
	BitDepth      int    `json:"bitDepth,omitempty"`
	SampleRate    int    `json:"sampleRate,omitempty"`
	Dither        string `json:"dither,omitempty"`
	Format        string `json:"format,omitempty"`
	DeviceRate    int    `json:"deviceRate,omitempty"`
	Options       string `json:"options,omitempty"`
	ScriptVersion string `json:"scriptVersion,omitempty"`
	RenderQuality string `json:"renderQuality,omitempty"`
	Measure       string `json:"measure,omitempty"`
	MonitorMode   string `json:"monitorMode,omitempty"`
}

// Result separates bounded JSON diagnostics from transferable binary audio buffers.
type Result struct {
	Metadata []byte
	Audio    []byte
}

// DecodeRequest rejects duplicate, aliased, unknown, null and unrelated fields.
func DecodeRequest(raw []byte) (Request, error) {
	var request Request
	if len(raw) == 0 || len(raw) > MaxMetadataBytes {
		return request, errors.New("local audio metadata exceeds its bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return request, errors.New("local audio metadata must be an object")
	}
	seen := make(map[string]bool, 9)
	for decoder.More() {
		key, keyErr := decoder.Token()
		name, ok := key.(string)
		if keyErr != nil || !ok || seen[name] {
			return request, errors.New("local audio metadata contains duplicate fields")
		}
		seen[name] = true
		var value json.RawMessage
		if decodeErr := decoder.Decode(&value); decodeErr != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return request, errors.New("local audio metadata contains an invalid value")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return request, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return request, errors.New("local audio metadata contains trailing data")
	}
	decode := json.NewDecoder(bytes.NewReader(raw))
	decode.DisallowUnknownFields()
	if err := decode.Decode(&request); err != nil {
		return request, fmt.Errorf("invalid local audio metadata: %w", err)
	}
	var allowed string
	switch request.Operation {
	case "render":
		allowed = " operation params script profile bitDepth sampleRate dither format measure monitorMode "
	case "features":
		allowed = " operation "
	case "deep":
		allowed = " operation profile scriptVersion renderQuality "
		if _, err := mastering.RenderQualityAlgorithm(request.RenderQuality); err != nil {
			return request, err
		}
		if seen["renderQuality"] && request.ScriptVersion != "2.0" {
			return request, errors.New("renderQuality requires ScriptV2")
		}
	case "reference":
		allowed = " operation params options "
	case "compile":
		allowed = " operation script deviceRate "
	case "transition":
		allowed = " operation bitDepth "
	default:
		return request, errors.New("unsupported local audio operation")
	}
	for key := range seen {
		if !strings.Contains(allowed, " "+key+" ") {
			return request, errors.New("local audio metadata contains an unknown or unrelated field")
		}
	}
	if seen["monitorMode"] && request.Format != "json" {
		return request, errors.New("monitorMode is only accepted on a JSON render measurement")
	}
	return request, nil
}

// Execute processes one isolated bounded request with the same native CDR and algorithms.
// The caller owns admission and must terminate the browser worker on cancellation.
func Execute(ctx context.Context, raw, source, reference []byte, progress func(int, string)) (*Result, error) {
	if ctx == nil {
		return nil, errors.New("local audio context is required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	request, err := DecodeRequest(raw)
	if err != nil {
		return nil, err
	}
	if len(source) > MaxInputBytes || len(reference) > MaxInputBytes-len(source) {
		return nil, errors.New("combined local audio inputs exceed 257 MiB")
	}
	if request.Operation == "compile" {
		if len(source) != 0 || len(reference) != 0 {
			return nil, errors.New("compilation accepts no audio inputs")
		}
		return compile(ctx, request)
	}
	if request.Operation == "transition" {
		return transition(ctx, request, source, reference)
	}
	if len(source) == 0 || (request.Operation != "reference" && len(reference) != 0) {
		return nil, errors.New("local audio operation has missing or unexpected input")
	}
	buf, err := audio.DecodeAndDisarm("source.wav", source)
	if err != nil {
		return nil, err
	}
	if progress != nil {
		progress(0, "Validated and reconstructed audio on this device")
	}
	switch request.Operation {
	case "render":
		return render(ctx, request, buf)
	case "features":
		features, err := mastering.AnalyzeFeaturesContext(ctx, buf, progress)
		if err != nil {
			return nil, err
		}
		return metadata(map[string]any{"kind": "analyze_features", "status": "done", "features": features})
	case "deep":
		profile, err := mastering.NormalizeProfile(request.Profile)
		if err != nil {
			return nil, err
		}
		if request.ScriptVersion == "2.0" {
			script, prediction, err := mastering.AnalyzeDeepV2QualityContext(ctx, buf, profile, request.RenderQuality, progress)
			if err != nil {
				return nil, err
			}
			return metadata(map[string]any{"kind": "analyze_deep_v2", "status": "done", "scriptV2": script, "prediction": prediction})
		}
		if request.ScriptVersion != "" {
			return nil, errors.New("unsupported local script version")
		}
		script, err := mastering.AnalyzeDeep(ctx, buf, profile, progress)
		if err != nil {
			return nil, err
		}
		return metadata(map[string]any{"kind": "analyze_deep", "status": "done", "script": script})
	case "reference":
		return matchReference(ctx, request, buf, reference, progress)
	default:
		return nil, errors.New("unsupported local audio operation")
	}
}

func metadata(value any) (*Result, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxMetadataBytes {
		return nil, errors.New("local audio result metadata exceeds its bound")
	}
	return &Result{Metadata: raw}, nil
}

func matchReference(ctx context.Context, request Request, source *audio.Buffer, raw []byte, progress func(int, string)) (*Result, error) {
	if len(raw) == 0 {
		return nil, errors.New("reference audio is required")
	}
	reference, err := audio.DecodeAndDisarm("reference.wav", raw)
	if err != nil {
		return nil, err
	}
	params := dsp.DefaultParams()
	if request.Params != "" {
		params, err = dsp.DecodeParamsJSON([]byte(request.Params), params)
		if err != nil {
			return nil, err
		}
	}
	options := mastering.ReferenceOptions{Amount: .5, ProtectBelowHz: 120}
	if request.Options != "" {
		options, err = mastering.DecodeReferenceOptionsJSON([]byte(request.Options))
		if err != nil {
			return nil, err
		}
	}
	proposal, err := mastering.MatchReferenceContext(ctx, source, reference, params, options, progress)
	if err != nil {
		return nil, err
	}
	return metadata(map[string]any{"kind": "analyze_reference", "status": "done", "referenceProposal": proposal})
}

func compile(ctx context.Context, request Request) (*Result, error) {
	script, err := mastering.DecodeScriptV2([]byte(request.Script))
	if err != nil {
		return nil, err
	}
	rate := request.DeviceRate
	if rate == 0 {
		rate = script.Source.SampleRate
	}
	schedule, err := mastering.ValidateScriptV2Context(ctx, script, rate)
	if err != nil {
		return nil, err
	}
	return metadata(map[string]any{"version": "1.0", "source": script.Source, "revision": script.Revision, "deviceRate": rate, "quantumFrames": schedule.Quantum(), "baseline": script.ChainParams, "moves": schedule.NumericMoves(), "targets": automation.Targets(), "sourceVerified": false})
}
