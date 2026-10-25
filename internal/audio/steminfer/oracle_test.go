package steminfer

// cspell:words STFT steminfer qkv PyTorch dtype

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"
)

type oracleTensor struct {
	Shape  []int `json:"shape"`
	Offset int   `json:"offset"`
	Bytes  int   `json:"bytes"`
}
type oracleMetadata struct {
	FFTVariant         string                  `json:"fftVariant"`
	Fixture            string                  `json:"fixture"`
	ArchitectureCommit string                  `json:"architectureCommit"`
	OriginalSHA256     string                  `json:"originalSHA256"`
	Samples            int                     `json:"samples"`
	Dtype              string                  `json:"dtype"`
	Tensors            map[string]oracleTensor `json:"tensors"`
	BinarySHA256       string                  `json:"binarySHA256"`
	ElapsedSeconds     float64                 `json:"elapsedSeconds"`
}

func boundedTestArtifact(path string, maximum int) ([]byte, error) {
	// #nosec G304 G703 -- Explicit opt-in local oracle artifact, never a request or upload path.
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return io.ReadAll(io.LimitReader(file, int64(maximum)+1))
}
func actualArchive(t *testing.T) *weightArchive {
	t.Helper()
	path := os.Getenv("AURIALIS_STEM_MODEL")
	if path == "" {
		t.Skip("set the trusted development model path")
	}
	// #nosec G304 G703 -- Explicit opt-in checksum-pinned development model artifact.
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.Size() != modelBytes {
		t.Fatal("wrong model size", err)
	}
	archive, err := readArchive(context.Background(), file, modelBytes, expectedModelSchema(), modelSHA256)
	if err != nil {
		t.Fatal(err)
	}
	return archive
}
func TestOriginalPyTorchIntermediateAndPCMParity(t *testing.T) { compareOriginalOracle(t, false) }
func TestOriginalNeuralPortFromExactFeatures(t *testing.T)     { compareOriginalOracle(t, true) }
func compareOriginalOracle(t *testing.T, exactFeatures bool) {
	if exactFeatures {
		t.Log("DIAGNOSTIC ONLY: original feature input; this is not end-to-end STFT acceptance")
	}
	directory := os.Getenv("AURIALIS_STEM_ORACLE")
	if directory == "" {
		t.Skip("set original PyTorch oracle directory")
	}
	metadataBytes, err := boundedTestArtifact(filepath.Join(directory, "oracle.json"), 65536)
	if err != nil || len(metadataBytes) > 65536 {
		t.Fatal("bounded oracle metadata", err)
	}
	var metadata oracleMetadata
	decoder := json.NewDecoder(bytes.NewReader(metadataBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		t.Fatal("trailing oracle metadata")
	}
	raw, err := boundedTestArtifact(filepath.Join(directory, "oracle.bin"), 64*1024*1024)
	if err != nil || len(raw) > 64*1024*1024 {
		t.Fatal("bounded oracle binary", err)
	}
	if err := validateOracleLayout(metadata, len(raw)); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != metadata.BinarySHA256 {
		t.Fatal("oracle binary checksum mismatch")
	}
	tensor := func(name string) []float32 {
		t.Helper()
		item, found := metadata.Tensors[name]
		if !found || item.Offset < 0 || item.Bytes < 0 || item.Offset > len(raw) || item.Bytes > len(raw)-item.Offset || item.Bytes%4 != 0 {
			t.Fatal("invalid oracle tensor", name)
		}
		values := make([]float32, item.Bytes/4)
		for i := range values {
			values[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[item.Offset+4*i : item.Offset+4*i+4]))
			if !finite32(values[i]) {
				t.Fatal("non-finite oracle")
			}
		}
		return values
	}
	source := tensor("source")
	if len(source) != metadata.Samples*2 {
		t.Fatal("wrong source shape")
	}
	archive := actualArchive(t)
	runner, err := newWindowRunner(context.Background(), archive, metadata.Samples)
	if err != nil {
		t.Fatal(err)
	}
	compared := make(map[string]bool, len(metadata.Tensors))
	compare := func(name string, got []float32) {
		t.Helper()
		if _, found := metadata.Tensors[name]; !found {
			return
		}
		compared[name] = true
		want := tensor(name)
		if len(got) != len(want) {
			t.Fatal("trace shape mismatch", name, len(got), len(want))
		}
		var maximum, errorPower, referencePower float64
		for i, value := range got {
			if !finite32(value) {
				t.Fatal("non-finite inference", name)
			}
			delta := float64(value) - float64(want[i])
			maximum = math.Max(maximum, math.Abs(delta))
			errorPower += delta * delta
			referencePower += float64(want[i]) * float64(want[i])
		}
		normalized := math.Sqrt(errorPower / math.Max(referencePower, 1e-30))
		t.Logf("%s count%d maxAbsolute%.9g normalizedRMS%.9g", name, len(got), maximum, normalized)
		if name == "features" && exactFeatures {
			copy(got, want)
		}
		if maximum > .003 || normalized > .001 {
			t.Errorf("original architecture numeric mismatch at %s", name)
		}
	}

	started := time.Now()
	err = runner.predict(context.Background(), source[:metadata.Samples], source[metadata.Samples:], []int{0, 1, 2, 3, 4}, func(head int, left, right []float32) error {
		label := [5]string{"vocal", "drums", "bass", "guitar", "piano"}[head]
		output := append(append([]float32{}, left...), right...)
		compare("pcm."+label, output)
		return nil
	}, inferenceHooks{trace: compare})
	if err != nil {
		t.Fatal(err)
	}
	for name := range metadata.Tensors {
		if name != "source" && name != "window" && !compared[name] {
			t.Errorf("required oracle trace was never compared: %s", name)
		}
	}
	t.Logf("Go original-model window %d samples: %s backend%s", metadata.Samples, time.Since(started), matrixBackendName())
}

const originalArchitectureCommit = "6fdad13686bb7e84d029ec66f9dbe76e65c93ebf"
const originalCheckpointSHA256 = "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"

func oracleShapes(samples int) map[string][]int {
	frames := samples/fftHop + 1
	shapes := map[string][]int{
		"source": {2, samples}, "window": {fftSize}, "features": {frames, featureCount},
	}
	for _, name := range []string{"band_split", "layer0.time", "layer0.frequency", "layer11.time", "layer11.frequency", "hidden"} {
		shapes[name] = []int{len(bandBins), frames, modelDimension}
	}
	for _, head := range []string{"vocal", "drums", "bass", "guitar", "piano"} {
		shapes["mask."+head] = []int{frames, featureCount}
		shapes["pcm."+head] = []int{2, samples}
	}
	return shapes
}
func validateOracleLayout(metadata oracleMetadata, binaryBytes int) error {
	if metadata.FFTVariant != "" && metadata.FFTVariant != "original_f32" {
		return errors.New("conditioning probes cannot replace original F32 oracle")
	}
	if metadata.Dtype != "F32" || metadata.Samples <= fftSize/2 || metadata.Samples > maximumWindowSamples ||
		metadata.ArchitectureCommit != originalArchitectureCommit || metadata.OriginalSHA256 != originalCheckpointSHA256 {
		return errors.New("invalid pinned original oracle provenance")
	}
	shapes := oracleShapes(metadata.Samples)
	if len(metadata.Tensors) != len(shapes) {
		return errors.New("incomplete oracle trace set")
	}
	ordered := make([]oracleTensor, 0, len(shapes))
	for name, shape := range shapes {
		tensor, found := metadata.Tensors[name]
		elements := 1
		for _, dimension := range shape {
			elements *= dimension
		}
		if !found || !slices.Equal(tensor.Shape, shape) || tensor.Bytes != elements*4 || tensor.Offset < 0 {
			return fmt.Errorf("invalid oracle tensor layout %s", name)
		}
		ordered = append(ordered, tensor)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Offset < ordered[j].Offset })
	offset := 0
	for _, tensor := range ordered {
		if tensor.Offset != offset || tensor.Bytes > binaryBytes-offset {
			return errors.New("oracle gap, overlap or out-of-bounds tensor")
		}
		offset += tensor.Bytes
	}
	if offset != binaryBytes {
		return errors.New("oracle binary has trailing data")
	}
	return nil
}
func TestOracleLayoutRequiresPinnedCompleteDisjointShapes(t *testing.T) {
	valid := func() (oracleMetadata, int) {
		result := oracleMetadata{Dtype: "F32", Samples: 2053, ArchitectureCommit: originalArchitectureCommit, OriginalSHA256: originalCheckpointSHA256, Tensors: map[string]oracleTensor{}}
		offset := 0
		names := make([]string, 0, 19)
		for name := range oracleShapes(result.Samples) {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			shape := oracleShapes(result.Samples)[name]
			elements := 1
			for _, dimension := range shape {
				elements *= dimension
			}
			result.Tensors[name] = oracleTensor{Shape: shape, Offset: offset, Bytes: elements * 4}
			offset += elements * 4
		}
		return result, offset
	}
	metadata, size := valid()
	if err := validateOracleLayout(metadata, size); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*oracleMetadata){
		func(m *oracleMetadata) { m.OriginalSHA256 = "wrong" },
		func(m *oracleMetadata) { m.FFTVariant = "f64_rounded" },
		func(m *oracleMetadata) { m.ArchitectureCommit = "wrong" },
		func(m *oracleMetadata) { delete(m.Tensors, "mask.bass") },
		func(m *oracleMetadata) { m.Tensors["extra"] = oracleTensor{} },
		func(m *oracleMetadata) { v := m.Tensors["features"]; v.Shape = []int{1, 1}; m.Tensors["features"] = v },
		func(m *oracleMetadata) { v := m.Tensors["features"]; v.Offset++; m.Tensors["features"] = v },
		func(m *oracleMetadata) { v := m.Tensors["features"]; v.Offset = 0; m.Tensors["features"] = v },
		func(m *oracleMetadata) { v := m.Tensors["pcm.vocal"]; v.Bytes -= 4; m.Tensors["pcm.vocal"] = v },
	} {
		candidate, n := valid()
		mutation(&candidate)
		if err := validateOracleLayout(candidate, n); err == nil {
			t.Fatal("hostile oracle layout accepted")
		}
	}
	if err := validateOracleLayout(metadata, size+1); err == nil {
		t.Fatal("trailing oracle bytes accepted")
	}
}
