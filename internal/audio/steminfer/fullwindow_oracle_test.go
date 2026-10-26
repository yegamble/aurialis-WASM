package steminfer

// cspell:words steminfer

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fullWindowTensor struct {
	Shape  []int `json:"shape"`
	Offset int   `json:"offset"`
	Bytes  int   `json:"bytes"`
}

// Opt-in: compares one full 20-second window with the original PyTorch model.
// Set AURIALIS_STEM_MODEL and AURIALIS_STEM_FULL_ORACLE to a directory written
// by testdata/fullwindow_oracle.py (oracle.json + oracle.bin).
func TestFullWindowMatchesPyTorchOriginal(t *testing.T) {
	directory := os.Getenv("AURIALIS_STEM_FULL_ORACLE")
	if directory == "" {
		t.Skip("set the full-window PyTorch oracle directory")
	}
	archive := actualArchive(t)
	metadataBytes, err := boundedTestArtifact(filepath.Join(directory, "oracle.json"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		Format  string                      `json:"format"`
		Samples int                         `json:"samples"`
		Tensors map[string]fullWindowTensor `json:"tensors"`
	}
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil || metadata.Format != "aurialis-original-full-window-v1" || metadata.Samples != maximumWindowSamples {
		t.Fatal("unexpected full-window oracle", err, metadata.Format, metadata.Samples)
	}
	raw, err := boundedTestArtifact(filepath.Join(directory, "oracle.bin"), 256<<20)
	if err != nil {
		t.Fatal(err)
	}
	read := func(name string) []float32 {
		tensor, ok := metadata.Tensors[name]
		if !ok || tensor.Offset < 0 || tensor.Bytes%4 != 0 || tensor.Offset+tensor.Bytes > len(raw) {
			t.Fatal("missing or out-of-range oracle tensor", name)
		}
		values := make([]float32, tensor.Bytes/4)
		for i := range values {
			values[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[tensor.Offset+4*i:]))
		}
		return values
	}
	source := read("source")
	samples := metadata.Samples
	runner, err := newWindowRunner(context.Background(), archive, samples, defaultWorkers())
	if err != nil {
		t.Fatal(err)
	}
	names := [5]string{"vocal", "drums", "bass", "guitar", "piano"}
	started := time.Now()
	err = runner.predict(context.Background(), source[:samples], source[samples:], []int{0, 1, 2, 3, 4}, func(head int, left, right []float32) error {
		expected := read("pcm." + names[head])
		var worst, errorEnergy, signalEnergy float64
		for channel, got := range [2][]float32{left, right} {
			for i, value := range got {
				want := float64(expected[channel*samples+i])
				difference := math.Abs(float64(value) - want)
				worst = math.Max(worst, difference)
				errorEnergy += difference * difference
				signalEnergy += want * want
			}
		}
		snr := 10 * math.Log10(signalEnergy/math.Max(errorEnergy, 1e-30))
		t.Logf("%s: max |Go-PyTorch| %.3g, SNR %.1f dB", names[head], worst, snr)
		if worst > 1e-4 || snr < 80 {
			t.Errorf("%s drifted from the original model: max %.3g, SNR %.1f dB", names[head], worst, snr)
		}
		return nil
	}, inferenceHooks{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("window took %v with %d lanes", time.Since(started), defaultWorkers())
}
