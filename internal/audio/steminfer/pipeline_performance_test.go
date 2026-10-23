package steminfer

// cspell:words steminfer GOMAXPROCS VECLIB OPENBLAS

import (
	"context"
	"math"
	"os"
	"runtime"
	"testing"
	"time"
)

// This opt-in test measures invariants and resources, never musical quality.
func TestMeasureFixedTwentySecondTrainedPipeline(t *testing.T) {
	if os.Getenv("AURIALIS_STEM_MEASURE_PIPELINE") != "1" {
		t.Skip("set explicit private full-context measurement opt-in")
	}
	const rate, frames, stems = 48000, 480000, 6
	resources, err := estimatePipeline(rate, frames, stems, maximumWindowSamples)
	if err != nil {
		t.Fatal(err)
	}
	if resources.window != 882000 || resources.heads != 5 {
		t.Fatal("production context or heads changed")
	}
	started := time.Now()
	archive := actualArchive(t)
	loaded := time.Now()
	source := [2][]float32{make([]float32, frames), make([]float32, frames)}
	seed := uint32(271828)
	for i := range frames {
		seed = seed*1664525 + 1013904223
		noise := (float64(seed)/4294967296 - .5) * .01
		seconds := float64(i) / rate
		source[0][i] = float32(.07*math.Sin(2*math.Pi*997*seconds) + .04*math.Sin(2*math.Pi*83*seconds) + noise)
		source[1][i] = float32(.06*math.Sin(2*math.Pi*631*seconds) + .03*math.Sin(2*math.Pi*137*seconds) - noise)
	}
	source[0][0], source[1][frames-1] = .4, -.3
	output := [stems][2][]float32{}
	for stem := range stems {
		for channel := range 2 {
			output[stem][channel] = make([]float32, frames)
		}
	}
	counts := [stems]int{}
	observedWindows := 0
	completedWindow, completedStep := -1, -1
	ctx, cancel := context.WithTimeout(context.Background(), 145*time.Second)
	defer cancel()
	processing := time.Now()
	err = runTrainedSeparation(ctx, archive, rate, stems, source[0], source[1], resources.requiredJobBytes, func(stem, start int, left, right []float32) error {
		if stem < 0 || stem >= stems || start != counts[stem] || len(left) != len(right) || start+len(left) > frames {
			t.Fatal("invalid retained output span")
		}
		copy(output[stem][0][start:], left)
		copy(output[stem][1][start:], right)
		counts[stem] += len(left)
		return nil
	}, func(p pipelineProgress) {
		if p.window < completedWindow || (p.window == completedWindow && p.completed <= completedStep) {
			t.Fatal("non-monotonic actual model progress")
		}
		completedWindow, completedStep, observedWindows = p.window, p.completed, p.windows
		if p.completed == p.total {
			t.Logf("actual full-context window %d/%d complete", p.window+1, p.windows)
		}
	})
	elapsed := time.Since(processing)
	t.Logf("backend=%s sourceRate=%d originalFrames=%d modelRate=%d modelFrames=%d contextSamples=%d observedWindows=%d load=%s pipeline=%s total=%s staticBytes=%d jobReservationBytes=%d retainedPCMBytes=%d GOMAXPROCS=%d VECLIB_MAXIMUM_THREADS=%s OPENBLAS_NUM_THREADS=%s", matrixBackendName(), rate, frames, modelSampleRate, resources.modelFrames, resources.window, observedWindows, loaded.Sub(started), elapsed, time.Since(started), len(archive.data), resources.requiredJobBytes, resources.retainedOutputBytes, runtime.GOMAXPROCS(0), os.Getenv("VECLIB_MAXIMUM_THREADS"), os.Getenv("OPENBLAS_NUM_THREADS"))
	if err != nil {
		t.Fatal(err)
	}
	if observedWindows != 1 || completedWindow != 0 || completedStep != 32 {
		t.Fatal("wrong actual window graph count", observedWindows, completedWindow, completedStep)
	}
	var maximumError float64
	for stem := range stems {
		if counts[stem] != frames {
			t.Fatal("original duration changed", stem, counts[stem])
		}
	}
	for channel := range 2 {
		for i := range frames {
			var sum float64
			for stem := range stems {
				value := output[stem][channel][i]
				if !finite32(value) {
					t.Fatal("non-finite delivered stem", stem, channel, i)
				}
				sum += float64(value)
			}
			maximumError = math.Max(maximumError, math.Abs(sum-float64(source[channel][i])))
		}
	}
	t.Logf("all six retained outputs finite; exact original duration; max absolute reconstruction error=%.12g", maximumError)
	if maximumError > 3e-8 {
		t.Fatal("original PCM reconstruction exceeded float32 budget", maximumError)
	}
}
