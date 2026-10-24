package dsp

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// cspell:ignore AUEXPS Mallocs untimed -- private screening stream magic
const (
	studioScreenWarmBlocks   = 64
	studioScreenVerifyBlocks = 32
	studioScreenTimedBlocks  = 32
	studioScreenBlock        = 128
	studioScreenSourceFrames = 16 * 1024 * 1024
)

// Preparation is outside all measured intervals. The steady source is exactly
// the published repeated128-frame diagnostic source; peaky adds explicit hot
// transients and is NOT described as a band-limited source or musical corpus.
func studioScreenInput(workload string) ([]float32, []float32) {
	left, right := studioGraphSignal(studioScreenBlock)
	for i := range left {
		left[i], right[i] = 4*left[i], 4*right[i]
	}
	if workload == "peaky" {
		for i := range left {
			left[i], right[i] = .125*left[i], .125*right[i]
		}
		left[0], right[0] = 4, -3
		left[37], right[37] = -2.5, 3.75
		left[91], right[91] = 3.25, 2.75
	}
	return left, right
}

func studioScreenRunBlocks(t *testing.T, w *studioExtremaRecorder, g *studioGraph, left, right []float32, blocks int) ([]float32, []float32) {
	t.Helper()
	frames := blocks * studioScreenBlock
	if blocks < 1 || blocks > studioScreenWarmBlocks || frames > studioExtremaFixtureFrames-w.frames {
		t.Fatal("private screen frame admission exceeded")
	}
	w.frames += frames
	outLeft, outRight := make([]float32, frames), make([]float32, frames)
	for block := range blocks {
		start := block * studioScreenBlock
		if g.processBlock(left, right, outLeft[start:start+studioScreenBlock], outRight[start:start+studioScreenBlock]) != studioScreenBlock {
			t.Fatal("private screen source callback stopped")
		}
	}
	return outLeft, outRight
}

func studioScreenMeasure(t *testing.T, w *studioExtremaRecorder, g *studioGraph, left, right []float32) {
	t.Helper()
	if err := g.resetAt(0); err != nil {
		t.Fatal(err)
	}
	_, _ = studioScreenRunBlocks(t, w, g, left, right, studioScreenWarmBlocks)
	const frames = studioScreenTimedBlocks * studioScreenBlock
	if frames > studioExtremaFixtureFrames-w.frames {
		t.Fatal("private timed frame admission exceeded")
	}
	w.frames += frames
	// All buffers, metadata, and admission work precede the measured interval.
	outLeft, outRight := make([]float32, frames), make([]float32, frames)
	startFrame := g.elapsed
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	for block := range studioScreenTimedBlocks {
		start := block * studioScreenBlock
		if g.processBlock(left, right, outLeft[start:start+studioScreenBlock], outRight[start:start+studioScreenBlock]) != studioScreenBlock {
			t.Fatal("private timed source callback stopped")
		}
	}
	elapsed := time.Since(started)
	runtime.ReadMemStats(&after)
	if elapsed <= 0 || after.Mallocs < before.Mallocs || after.TotalAlloc < before.TotalAlloc || startFrame != studioScreenWarmBlocks*studioScreenBlock || g.elapsed != (studioScreenWarmBlocks+studioScreenTimedBlocks)*studioScreenBlock {
		t.Fatal("invalid private timing or source clock observation")
	}
	// Preserve every observed result. Hashing/reflection/encoding/IO is untimed.
	w.number(uint64(startFrame)) // #nosec G115 -- checked fixed nonnegative clock
	w.number(uint64(g.elapsed))  // #nosec G115 -- checked fixed nonnegative clock
	w.pcm(outLeft, outRight, false)
	w.numericState(g)
	w.number(uint64(elapsed.Nanoseconds())) // #nosec G115 -- checked positive duration
	w.number(after.Mallocs - before.Mallocs)
	w.number(after.TotalAlloc - before.TotalAlloc)
}

func TestWriteStudioExtremaScreen(t *testing.T) {
	directory := os.Getenv("AURIALIS_STUDIO_SCREEN_OUTPUT")
	if directory == "" {
		t.Skip("private opt-in fixed-count paired-module screen")
	}
	rate, err := strconv.Atoi(os.Getenv("AURIALIS_STUDIO_SCREEN_RATE"))
	phase := os.Getenv("AURIALIS_STUDIO_SCREEN_PHASE")
	workload := os.Getenv("AURIALIS_STUDIO_SCREEN_WORKLOAD")
	// Initial admission is ONLY the reviewed192k Tube/Optical scope. Expanding
	// rates, models, workloads or history requires a separate source ruling.
	if err != nil || rate != 192000 || !filepath.IsAbs(directory) || (phase != "verify" && phase != "measure") || (workload != "steady" && workload != "peaky") {
		t.Fatal("closed private screening admission refused")
	}
	graphBytes := reflect.TypeFor[studioGraph]().Size() + reflect.TypeFor[Engine]().Size() + reflect.TypeFor[studioAudibleLimiterPath]().Size() + reflect.TypeFor[studioAudibleKernel]().Size() + reflect.TypeFor[studioPartitionedPostGuardPath]().Size() + reflect.TypeFor[studioPartitionedPostGuardKernel]().Size()
	// SixMiB preparation/scratch + explicit320KiB test data/encoding allowance.
	// This bounds test-owned values only, not Go/V8 memory, RSS or GC behavior.
	if graphBytes+320*1024 > 2*1024*1024 {
		t.Fatal("private screening live-object admission exceeded")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	}()
	file, err := root.OpenFile(fmt.Sprintf("rate%d.bin", rate), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			t.Error(err)
		}
	}()
	w := studioExtremaRecorder{t: t, out: bufio.NewWriterSize(file, 65536), input: sha256.New()}
	w.write([]byte("AUEXPS01"))
	w.number(uint64(rate)) // #nosec G115 -- closed positive rate
	w.blob([]byte(phase))
	w.blob([]byte(workload))
	params := studioAudibleGraphActiveParams()
	params.Compressor.MakeupDB, params.DitherBits = 12, 24
	if params.Saturation.Character != SatTube || params.Compressor.Topology != CompOptical {
		t.Fatal("published Tube/default compressor fixture changed")
	}
	metadata, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	w.blob(metadata)
	_, _ = w.input.Write(metadata)
	left, right := studioScreenInput(workload)
	w.pcm(left, right, true)
	for mode, repeat := range []bool{false, true} {
		w.number(uint64(mode)) // #nosec G115 -- fixed closed modes0/1
		g := mustStudioPartitionedAudibleGraph(t, float64(rate), params, studioScreenSourceFrames, repeat)
		w.number(uint64(g.latency)) // #nosec G115 -- constructor validates nonnegative latency
		w.number(uint64(g.frames))  // #nosec G115 -- fixed positive source size
		_, _ = studioScreenRunBlocks(t, &w, g, left, right, studioScreenWarmBlocks)
		verifyLeft, verifyRight := studioScreenRunBlocks(t, &w, g, left, right, studioScreenVerifyBlocks)
		w.pcm(verifyLeft, verifyRight, false)
		w.numericState(g)
		if g.origin != 0 || g.elapsed != (studioScreenWarmBlocks+studioScreenVerifyBlocks)*studioScreenBlock || g.draining || g.remaining != 0 {
			t.Fatal("private verification source epoch changed")
		}
		w.number(uint64(g.elapsed)) // #nosec G115 -- checked fixed nonnegative clock
		if phase == "measure" {
			studioScreenMeasure(t, &w, g, left, right)
		}
	}
	expectedFrames := 2 * (studioScreenWarmBlocks + studioScreenVerifyBlocks) * studioScreenBlock
	if phase == "measure" {
		expectedFrames += 2 * (studioScreenWarmBlocks + studioScreenTimedBlocks) * studioScreenBlock
	}
	if w.frames != expectedFrames || w.frames*4 > 800000 {
		t.Fatal("screening work accounting changed")
	}
	w.number(uint64(w.frames))    // #nosec G115 -- checked fixed positive work count
	w.number(uint64(w.words))     // #nosec G115 -- bounded numeric state word count
	w.number(uint64(w.bytes + 8)) // #nosec G115 -- bounded final stream size
	if err := w.out.Flush(); err != nil {
		t.Fatal(err)
	}
	t.Logf("cases2 rate%d baseFrames%d numericWords%d outputBytes%d fixedGraphBytes%d inputSHA256%x", rate, w.frames, w.words, w.bytes, graphBytes, w.input.Sum(nil))
}
