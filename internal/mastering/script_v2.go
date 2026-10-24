// cspell:words automator

package mastering

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// MaxScriptV2Bytes bounds both authored JSON and retained typed script data.
const MaxScriptV2Bytes = 2 * 1024 * 1024

// ScriptV2 is a source-bound measured mastering proposal with an explicit static baseline.
// Schema version 2.0 is independent of the DSP algorithm version (1, or 2 for exports).
type ScriptV2 struct {
	Version       string            `json:"version"`
	Source        SourceIdentity    `json:"source"`
	Revision      uint64            `json:"revision"`
	Profile       ProfileID         `json:"profile"`
	Summary       string            `json:"summary"`
	Sections      []FeatureSection  `json:"sections"`
	Moves         []automation.Move `json:"moves"`
	Findings      []Finding         `json:"findings"`
	ChainParams   dsp.Params        `json:"chainParams"`
	BeforeMetrics dsp.Metrics       `json:"beforeMetrics"`
}

// DecodeScriptV2 rejects unknown, duplicate, case-aliased, missing and null fields.
// Decoding and schedule compilation belong off the audio/render callback thread.
func DecodeScriptV2(data []byte) (*ScriptV2, error) {
	if len(data) == 0 || len(data) > MaxScriptV2Bytes {
		return nil, errors.New("script JSON exceeds 2 MiB or is empty")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := validateTypedJSON(decoder, reflect.TypeFor[ScriptV2](), 0); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("script JSON contains trailing data")
	}
	var script ScriptV2
	if err := json.Unmarshal(data, &script); err != nil {
		return nil, fmt.Errorf("invalid script JSON: %w", err)
	}
	return &script, nil
}

func validateTypedJSON(decoder *json.Decoder, kind reflect.Type, depth int) error {
	if depth > 32 {
		return errors.New("script JSON exceeds nesting limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		return errors.New("script JSON null is not permitted")
	}
	switch {
	case kind.Kind() == reflect.Struct:
		if token != json.Delim('{') {
			return errors.New("script JSON object required")
		}
		fields := make(map[string]reflect.StructField, kind.NumField())
		required := make(map[string]bool, kind.NumField())
		for i := 0; i < kind.NumField(); i++ {
			field := kind.Field(i)
			tag := strings.Split(field.Tag.Get("json"), ",")
			if tag[0] == "" || tag[0] == "-" {
				continue
			}
			fields[tag[0]] = field
			if len(tag) == 1 {
				required[tag[0]] = true
			}
		}
		seen := make(map[string]bool, len(fields))
		for decoder.More() {
			keyToken, keyErr := decoder.Token()
			if keyErr != nil {
				return keyErr
			}
			key, ok := keyToken.(string)
			field, known := fields[key]
			if !ok || !known || seen[key] {
				return errors.New("script JSON unknown or duplicate field")
			}
			seen[key] = true
			delete(required, key)
			if err := validateTypedJSON(decoder, field.Type, depth+1); err != nil {
				return err
			}
		}
		if _, err := decoder.Token(); err != nil {
			return err
		}
		if len(required) != 0 {
			return errors.New("script JSON missing required field")
		}
	case kind.Kind() == reflect.Slice || kind.Kind() == reflect.Array:
		if token != json.Delim('[') {
			return errors.New("script JSON array required")
		}
		count := 0
		for decoder.More() {
			if count > 32768 {
				return errors.New("script JSON array exceeds limit")
			}
			if err := validateTypedJSON(decoder, kind.Elem(), depth+1); err != nil {
				return err
			}
			count++
		}
		if _, err := decoder.Token(); err != nil {
			return err
		}
		if kind.Kind() == reflect.Array && count != kind.Len() {
			return errors.New("script JSON fixed array has wrong length")
		}
	case kind.Kind() == reflect.String:
		if _, ok := token.(string); !ok {
			return errors.New("script JSON string required")
		}
	case kind.Kind() == reflect.Bool:
		if _, ok := token.(bool); !ok {
			return errors.New("script JSON boolean required")
		}
	default:
		if _, ok := token.(json.Number); !ok {
			return errors.New("script JSON number required")
		}
	}
	return nil
}

// ValidateScriptV2Context validates the full contract and compiles at the explicit device rate.
// Native renders separately verify the source's canonical PCM digest before processing.
func ValidateScriptV2Context(ctx context.Context, script *ScriptV2, deviceRate int) (*automation.Schedule, error) {
	if ctx == nil {
		return nil, errors.New("context required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if script == nil || script.Version != "2.0" || !ValidSourceIdentity(script.Source) || len(script.Summary) > 4096 || len(script.Sections) < 1 || len(script.Sections) > 128 || len(script.Findings) > 128 {
		return nil, errors.New("invalid script version, source or metadata bounds")
	}
	profile, err := NormalizeProfile(string(script.Profile))
	if err != nil || profile != script.Profile {
		return nil, errors.New("canonical profile required")
	}
	// Algorithm 1 only supports the sample-peak limiter; algorithm 2 (exports)
	// selects its lookahead true-peak limiter with TruePeak.
	legacyTruePeak := script.ChainParams.Limiter.TruePeak && script.ChainParams.AlgorithmVersion != dsp.TruePeakAlgorithmVersion
	if script.ChainParams.Repair.Enabled || (script.ChainParams.Limiter.Enabled && legacyTruePeak) {
		return nil, errors.New("ScriptV2 requires disabled repair and, before algorithm 2, the sample-peak limiter")
	}
	if err := dsp.ValidateParams(script.ChainParams); err != nil {
		return nil, err
	}
	sections := make(map[string]FeatureSection, len(script.Sections))
	end := int64(0)
	for _, section := range script.Sections {
		if section.ID == "" || len(section.ID) > 128 || len(section.Name) > 256 || section.RoleHint != "unknown" || section.StartFrame != end || section.EndFrame <= end || section.EndFrame > script.Source.Frames || !isFinite(section.Confidence) || section.Confidence < 0 || section.Confidence > 1 {
			return nil, errors.New("invalid neutral section coverage")
		}
		if _, exists := sections[section.ID]; exists {
			return nil, errors.New("duplicate section ID")
		}
		sections[section.ID] = section
		end = section.EndFrame
	}
	if end != script.Source.Frames {
		return nil, errors.New("sections must cover the complete source")
	}
	for _, move := range script.Moves {
		section, ok := sections[move.SectionID]
		if !ok || len(move.Points) < 2 || move.Points[0].Frame < section.StartFrame || move.Points[len(move.Points)-1].Frame > section.EndFrame {
			return nil, errors.New("move must belong to its referenced section")
		}
	}
	for _, finding := range script.Findings {
		if len(finding.ID) > 128 || len(finding.Title) > 256 || len(finding.Detail) > 2048 || len(finding.Lane) > 128 || (finding.Severity != "info" && finding.Severity != "warning") {
			return nil, errors.New("invalid finding metadata")
		}
	}
	encoded, err := json.Marshal(script)
	if err != nil || len(encoded) > MaxScriptV2Bytes {
		return nil, errors.New("script exceeds retained JSON bounds or contains nonfinite metadata")
	}
	return automation.CompileContext(ctx, script.Source.SampleRate, deviceRate, script.Source.Frames, script.Revision, automator.ValuesOf(script.ChainParams), script.Moves)
}

// ValidSourceIdentity accepts only the current canonical PCM layout and lowercase SHA-256 digest.
func ValidSourceIdentity(source SourceIdentity) bool {
	if source.SampleRate < 8000 || source.SampleRate > 192000 || source.Frames < 1 || source.Frames > audio.MaxDecodedFrames || len(source.PCMHash) != 64 || strings.ToLower(source.PCMHash) != source.PCMHash {
		return false
	}
	_, err := hex.DecodeString(source.PCMHash)
	return err == nil
}

// RenderScriptV2Context renders exact source-frame automation through the common evaluator.
// It never normalizes loudness or implicitly enables processing modules.
func RenderScriptV2Context(ctx context.Context, buf *audio.Buffer, script *ScriptV2) ([]float32, []float32, dsp.Metrics, error) {
	identity, err := SourceIdentityContext(ctx, buf)
	if err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	if script == nil || identity != script.Source {
		return nil, nil, dsp.Metrics{}, errors.New("script source identity does not match canonical PCM")
	}
	schedule, err := ValidateScriptV2Context(ctx, script, buf.SampleRate)
	if err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	engine := dsp.NewEngine(float64(buf.SampleRate))
	processor, err := automator.New(engine, script.ChainParams, schedule)
	if err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	left, right, err := dsp.RenderLatencyCompensated(engine, len(buf.Left), func(left, right []float32) error {
		for start := 0; start < len(left); start += 4096 {
			if err := ctx.Err(); err != nil {
				return err
			}
			end := min(start+4096, len(left))
			if !processor.ProcessBlock(buf.Left[start:end], buf.Right[start:end], left[start:end], right[start:end]) {
				return errors.New("compiled automation invariant failed")
			}
		}
		return nil
	})
	if err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	metrics, err := dsp.MeasureStereoContext(ctx, left, right, float64(buf.SampleRate))
	metrics.GainReductionDB = engine.LastGainReductionDB()
	if err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	return left, right, metrics, nil
}

// ErrScriptV2Storage reports a result that cannot fit the retained script contract.
var ErrScriptV2Storage = errors.New("ScriptV2 exceeds retained result bounds")

// Clone returns an independently editable snapshot for job consumers.
func (script *ScriptV2) Clone() *ScriptV2 {
	if script == nil {
		return nil
	}
	copyScript := *script
	copyScript.Sections = append([]FeatureSection{}, script.Sections...)
	copyScript.Findings = append([]Finding{}, script.Findings...)
	copyScript.Moves = append([]automation.Move{}, script.Moves...)
	for i := range copyScript.Moves {
		copyScript.Moves[i].Points = append([]automation.Point{}, script.Moves[i].Points...)
	}
	return &copyScript
}
