package jobs_test

import (
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func makeTestBuffer() *audio.Buffer {
	const sr = 48000
	const n = 12000 // 0.25s
	left := make([]float32, n)
	right := make([]float32, n)
	for i := 0; i < n; i++ {
		tm := float64(i) / float64(sr)
		v := float32(0.4 * math.Sin(2.0*math.Pi*440.0*tm))
		left[i] = v
		right[i] = v
	}
	return &audio.Buffer{
		SampleRate: sr,
		Channels:   2,
		Frames:     n,
		Duration:   0.25,
		Left:       left,
		Right:      right,
	}
}

func TestConcurrentJobSubmissionAndIdempotentCancel(t *testing.T) {
	mgr := jobs.NewManager(4)
	defer mgr.Close()
	_ = mgr.SetSeparator(splitEvenly)

	buf := makeTestBuffer()
	const totalJobs = 20

	var wg sync.WaitGroup
	jobIDs := make([]string, totalJobs)

	for i := 0; i < totalJobs; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if idx%2 == 0 {
				j, err := mgr.SubmitSeparate(buf, 4)
				if err != nil {
					if !errors.Is(err, jobs.ErrQueueFull) {
						t.Errorf("SubmitSeparate(%d) failed: %v", idx, err)
					}
					return
				}
				jobIDs[idx] = j.ID
				if idx%4 == 0 {
					mgr.Cancel(j.ID)
					mgr.Cancel(j.ID) // Idempotent second cancel
				}
			} else {
				j, err := mgr.SubmitAnalyzeDeep(buf, mastering.ProfilePunchyCommercial)
				if err != nil {
					if !errors.Is(err, jobs.ErrQueueFull) {
						t.Errorf("SubmitAnalyzeDeep(%d) failed: %v", idx, err)
					}
					return
				}
				jobIDs[idx] = j.ID
			}
		}(i)
	}
	wg.Wait()
	accepted := 0
	for _, id := range jobIDs {
		if id != "" {
			accepted++
		}
	}
	if accepted == 0 {
		t.Fatal("no job admitted within the memory budget")
	}

	// This checks eventual settlement, not DSP throughput. Race instrumentation
	// competes with other package suites on shared CI and developer machines.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		allSettled := true
		for _, id := range jobIDs {
			if id == "" {
				continue
			} // Bounded admission may reject concurrent submissions.
			j, ok := mgr.Get(id)
			if !ok {
				t.Fatalf("job %s missing", id)
			}
			if j.Status == jobs.StatusQueued || j.Status == jobs.StatusRunning {
				allSettled = false
				break
			}
		}
		if allSettled {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("timed out waiting for admitted concurrent jobs to settle")
}
