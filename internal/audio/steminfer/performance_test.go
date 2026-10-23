package steminfer

// cspell:words steminfer

import (
	"context"
	"math"
	"os"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

func TestMeasureCompleteTrainedWindow(t *testing.T) {
	path := os.Getenv("AURIALIS_STEM_MEASURE_WAV")
	if path == "" {
		t.Skip("set trusted actual-music performance input")
	}
	raw, err := boundedTestArtifact(path, 8*1024*1024)
	if err != nil || len(raw) > 8*1024*1024 {
		t.Fatal("bounded source fixture", err)
	}
	source, err := audio.DecodeAndDisarm("performance.wav", raw)
	if err != nil {
		t.Fatal(err)
	}
	if source.SampleRate != 44100 || source.Frames <= 1024 || source.Frames > maximumWindowSamples {
		t.Fatal("fixture must be44.1k bounded stereo")
	}
	started := time.Now()
	archive := actualArchive(t)
	loaded := time.Now()
	runner, err := newWindowRunner(context.Background(), archive, source.Frames)
	if err != nil {
		t.Fatal(err)
	}
	prepared := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	err = runner.predict(ctx, source.Left, source.Right, []int{0, 1, 2, 3, 4}, func(head int, left, right []float32) error {
		var power float64
		for i := range left {
			if !finite32(left[i]) || !finite32(right[i]) {
				t.Fatal("non-finite trained output")
			}
			power += (float64(left[i])*float64(left[i]) + float64(right[i])*float64(right[i])) / 2
		}
		t.Logf("head%d RMS%.9g", head, math.Sqrt(power/float64(len(left))))
		return nil
	}, inferenceHooks{})
	t.Logf("backend%s samples%d load%s allocation%s forward%s weightBytes%d workingArrayBytes%d", matrixBackendName(), source.Frames, loaded.Sub(started), prepared.Sub(loaded), time.Since(prepared), len(archive.data), runner.work.storageBytes())
	if err != nil {
		t.Fatal(err)
	}
}
