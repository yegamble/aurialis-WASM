package steminfer

// cspell:words steminfer GOMAXPROCS VECLIB OPENBLAS

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

type qualificationArtifact struct {
	Name   string `json:"name"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// TestMeasureLicensedTrainedPipeline is an opt-in development recorder, never a
// normal request route. Its inputs/outputs are explicit trusted local artifacts.
// Quality is evaluated independently against stored truth, never asserted from
// a stem's energy or from reconstruction (the residual guarantees the latter).
func TestMeasureLicensedTrainedPipeline(t *testing.T) {
	if os.Getenv("AURIALIS_STEM_QUALIFICATION") != "1" {
		t.Skip("set explicit private licensed-music qualification opt-in")
	}
	path := os.Getenv("AURIALIS_STEM_QUALIFICATION_SOURCE")
	parent := os.Getenv("AURIALIS_STEM_QUALIFICATION_OUTPUT")
	if path == "" || parent == "" {
		t.Fatal("explicit trusted source and owned output directory required")
	}
	const frames, rate, stems = 441000, 44100, 6
	raw, err := boundedTestArtifact(path, 44+frames*8)
	if err != nil || len(raw) != 44+frames*8 {
		t.Fatal("bounded ten-second canonical source required", err)
	}
	sourceHash := sha256.Sum256(raw)
	source, err := audio.DecodeAndDisarm("qualification.wav", raw)
	if err != nil || source.SampleRate != rate || source.Frames != frames || source.Channels != 2 {
		t.Fatal("fixed licensed source layout required", err)
	}
	resources, err := estimatePipeline(rate, frames, stems, maximumWindowSamples)
	if err != nil || resources.window != 882000 || resources.heads != 5 {
		t.Fatal("production context or head set changed", err)
	}
	// #nosec G703 -- Explicit opt-in owned development artifact directory, never request-derived.
	directory, err := os.MkdirTemp(parent, "native-")
	if err != nil {
		t.Fatal(err)
	}
	output := [stems][2][]float32{}
	for stem := range stems {
		for channel := range 2 {
			output[stem][channel] = make([]float32, frames)
		}
	}
	started := time.Now()
	archive := actualArchive(t)
	loaded := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 145*time.Second)
	defer cancel()
	counts := [stems]int{}
	windows, finalStep := 0, -1
	err = runTrainedSeparation(ctx, archive, rate, stems, source.Left, source.Right, resources.requiredJobBytes, func(stem, first int, left, right []float32) error {
		if stem < 0 || stem >= stems || first != counts[stem] || len(left) != len(right) || first+len(left) > frames {
			t.Fatal("invalid delivered source span")
		}
		copy(output[stem][0][first:], left)
		copy(output[stem][1][first:], right)
		counts[stem] += len(left)
		return nil
	}, func(progress pipelineProgress) {
		if progress.windows != 1 || progress.window != 0 || progress.completed <= finalStep {
			t.Fatal("actual production context/progress changed")
		}
		windows, finalStep = progress.windows, progress.completed
		if progress.completed%4 == 0 || progress.completed == progress.total {
			t.Logf("full-context progress %d/%d elapsed=%s", progress.completed, progress.total, time.Since(loaded))
		}
	})
	elapsed := time.Since(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if windows != 1 || finalStep != 32 {
		t.Fatal("wrong actual full-context graph count")
	}
	var maximumError float64
	for stem := range stems {
		if counts[stem] != frames {
			t.Fatal("source duration changed", stem, counts[stem])
		}
	}
	for channel, original := range [2][]float32{source.Left, source.Right} {
		for index, sample := range original {
			var sum float64
			for stem := range stems - 1 {
				value := output[stem][channel][index]
				if !finite32(value) {
					t.Fatal("non-finite delivered trained stem", stem, channel, index)
				}
				sum += float64(value)
			}
			residual := output[stems-1][channel][index]
			expectedResidual := float32(float64(sample) - sum)
			if !finite32(residual) || math.Float32bits(residual) != math.Float32bits(expectedResidual) {
				t.Fatal("delivered residual differs from exact original-PCM subtraction", channel, index)
			}
			maximumError = math.Max(maximumError, math.Abs(sum+float64(residual)-float64(sample)))
		}
	}
	names, err := stemNames(stems)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := make([]qualificationArtifact, 0, stems)
	for stem := range stems {
		encoded, encodeErr := audio.EncodeWAV(output[stem][0], output[stem][1], rate, 32)
		if encodeErr != nil || len(encoded) != 44+frames*8 {
			t.Fatal("fixed float export changed", encodeErr)
		}
		name := names[stem] + ".wav"
		// #nosec G703 -- Closed stem name inside our newly-created opt-in test artifact directory.
		if writeErr := os.WriteFile(filepath.Join(directory, name), encoded, 0o600); writeErr != nil {
			t.Fatal(writeErr)
		}
		digest := sha256.Sum256(encoded)
		artifacts = append(artifacts, qualificationArtifact{Name: name, Bytes: len(encoded), SHA256: hex.EncodeToString(digest[:])})
	}
	evidence := map[string]any{"format": "aurialis-private-native-qualification-v1", "sourceSHA256": hex.EncodeToString(sourceHash[:]), "modelSHA256": modelSHA256, "sourceRate": rate, "sourceFrames": frames, "contextSamples": resources.window, "windows": windows, "heads": 5, "backend": matrixBackendName(), "pipelineSeconds": elapsed.Seconds(), "loadSeconds": loaded.Sub(started).Seconds(), "staticModelBytes": modelBytes, "requiredJobBytes": resources.requiredJobBytes, "retainedPCMBytes": resources.retainedOutputBytes, "encodedArtifactBytes": stems * (44 + frames*8), "maximumReconstructionError": maximumError, "GOMAXPROCS": runtime.GOMAXPROCS(0), "VECLIB_MAXIMUM_THREADS": os.Getenv("VECLIB_MAXIMUM_THREADS"), "OPENBLAS_NUM_THREADS": os.Getenv("OPENBLAS_NUM_THREADS"), "artifacts": artifacts, "scope": "fixed-context native output recorder; quality and original-model comparison evaluated separately"}
	metadata, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Fixed receipt name in our newly-created opt-in test artifact directory.
	if err := os.WriteFile(filepath.Join(directory, "native.json"), append(metadata, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("native qualification retained at %s pipeline=%s maxReconstruction=%.12g", directory, elapsed, maximumError)
}
