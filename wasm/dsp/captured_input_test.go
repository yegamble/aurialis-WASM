// cspell:words automator

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

const capturedFixtureBytes = 32 * 1024 * 1024
const capturedDeviceFrames = 262144

type capturedDeviceInput struct {
	SourceRate     int                `json:"sourceRate"`
	Frames         int64              `json:"frames"`
	DeviceRate     int                `json:"deviceRate"`
	Seek           int64              `json:"seek"`
	Looping        bool               `json:"looping"`
	CapturedFrames int                `json:"capturedFrames"`
	Script         mastering.ScriptV2 `json:"script"`
	DeviceLeft     []float32          `json:"deviceLeft"`
	DeviceRight    []float32          `json:"deviceRight"`
}
type capturedDeviceOutput struct {
	DeviceRate     int       `json:"deviceRate"`
	CapturedFrames int       `json:"capturedFrames"`
	SourceVerified bool      `json:"sourceVerified"`
	OutputLeft     []float32 `json:"outputLeft"`
	OutputRight    []float32 `json:"outputRight"`
}

// This test-only oracle consumes actual browser-resampled device PCM. It does not
// rehash it as if it were original source PCM, and is never linked into the API.
func renderCapturedDeviceInput(ctx context.Context, input *capturedDeviceInput) (*capturedDeviceOutput, error) {
	if input == nil || input.CapturedFrames < 1 || input.CapturedFrames > capturedDeviceFrames || len(input.DeviceLeft) != input.CapturedFrames || len(input.DeviceRight) != input.CapturedFrames || input.SourceRate != input.Script.Source.SampleRate || input.Frames != input.Script.Source.Frames {
		return nil, errors.New("invalid captured device layout or source metadata")
	}
	schedule, err := mastering.ValidateScriptV2Context(ctx, &input.Script, input.DeviceRate)
	if err != nil {
		return nil, err
	}
	processor, err := automator.New(dsp.NewEngine(float64(input.DeviceRate)), input.Script.ChainParams, schedule)
	if err != nil {
		return nil, err
	}
	processor.SetLooping(input.Looping)
	if err := processor.SeekSourceFrame(input.Seek); err != nil {
		return nil, err
	}
	for i := range input.DeviceLeft {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if math.IsNaN(float64(input.DeviceLeft[i])) || math.IsNaN(float64(input.DeviceRight[i])) || math.IsInf(float64(input.DeviceLeft[i]), 0) || math.IsInf(float64(input.DeviceRight[i]), 0) {
			return nil, errors.New("captured device PCM must be finite")
		}
		if input.DeviceLeft[i] == 0 {
			input.DeviceLeft[i] = 0
		}
		if input.DeviceRight[i] == 0 {
			input.DeviceRight[i] = 0
		}
	}
	output := &capturedDeviceOutput{DeviceRate: input.DeviceRate, CapturedFrames: input.CapturedFrames, OutputLeft: make([]float32, input.CapturedFrames), OutputRight: make([]float32, input.CapturedFrames)}
	for start := 0; start < input.CapturedFrames; start += 128 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+128, input.CapturedFrames)
		if !processor.ProcessBlock(input.DeviceLeft[start:end], input.DeviceRight[start:end], output.OutputLeft[start:end], output.OutputRight[start:end]) {
			return nil, errors.New("captured schedule invariant failed")
		}
	}
	// Match the live numeric bridge's canonical zero sign.
	for i := range output.OutputLeft {
		if output.OutputLeft[i] == 0 {
			output.OutputLeft[i] = 0
		}
		if output.OutputRight[i] == 0 {
			output.OutputRight[i] = 0
		}
	}
	return output, nil
}

func TestCapturedDeviceNativeOracle(t *testing.T) {
	inputPath, outputPath := os.Getenv("AURIALIS_CAPTURED_INPUT_FIXTURE"), os.Getenv("AURIALIS_CAPTURED_OUTPUT_FIXTURE")
	if inputPath == "" && outputPath == "" {
		t.Skip("set captured input/output artifact paths for actual browser PCM comparison")
	}
	if inputPath == "" || outputPath == "" || len(inputPath) > 4096 || len(outputPath) > 4096 {
		t.Fatal("both bounded test artifact paths are required")
	}
	// #nosec G304 G703 -- Test-only fixture path supplied by the local browser harness; never an upload or HTTP path.
	file, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, capturedFixtureBytes+1))
	if err != nil || len(data) > capturedFixtureBytes {
		t.Fatal("captured JSON exceeds 32 MiB or cannot be read", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input capturedDeviceInput
	if err := decoder.Decode(&input); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatal("captured fixture contains trailing data")
	}
	output, err := renderCapturedDeviceInput(context.Background(), &input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Test-only output artifact supplied by the local browser harness; never an audio/request destination.
	if err := os.WriteFile(outputPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCapturedDeviceNativeOracleBoundsAndExactFrames(t *testing.T) {
	input := capturedDeviceInput{SourceRate: 8001, Frames: 129, DeviceRate: 44100, Seek: 123, Looping: true, CapturedFrames: 65, DeviceLeft: make([]float32, 65), DeviceRight: make([]float32, 65), Script: mastering.ScriptV2{Version: "2.0", Source: mastering.SourceIdentity{PCMHash: strings.Repeat("0", 64), SampleRate: 8001, Frames: 129}, Revision: 1, Profile: mastering.ProfileDynamicOpen, Summary: "Captured fixture", ChainParams: dsp.DefaultParams(), Sections: []mastering.FeatureSection{{ID: "section-1", Name: "Section 1", EndFrame: 129, RoleHint: "unknown"}}, Moves: []automation.Move{}, Findings: []mastering.Finding{}}}
	for i := range input.DeviceLeft {
		input.DeviceLeft[i] = .1
		input.DeviceRight[i] = -.2
	}
	output, err := renderCapturedDeviceInput(context.Background(), &input)
	if err != nil || len(output.OutputLeft) != 65 || len(output.OutputRight) != 65 || output.SourceVerified {
		t.Fatal("oracle changed declared capture layout", err)
	}
	if output.OutputLeft[64] != .1 || output.OutputRight[64] != -.2 {
		t.Fatal("oracle introduced hidden gain")
	}
	input.CapturedFrames++
	if _, err := renderCapturedDeviceInput(context.Background(), &input); err == nil {
		t.Fatal("mismatched capture count accepted")
	}
	input.CapturedFrames--
	input.SourceRate++
	if _, err := renderCapturedDeviceInput(context.Background(), &input); err == nil {
		t.Fatal("source clock mismatch accepted")
	}
	input.SourceRate--
	input.DeviceLeft[64] = float32(math.Inf(1))
	if _, err := renderCapturedDeviceInput(context.Background(), &input); err == nil {
		t.Fatal("nonfinite captured PCM accepted")
	}
}
