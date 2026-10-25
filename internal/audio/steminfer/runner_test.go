package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"testing"
)

func TestWorkingStorageAdmissionMatchesActualSmallWindows(t *testing.T) {
	for _, samples := range []int{1025, 2053, 44100} {
		work := newNetworkWorkspace(samples)
		if got, want := work.storageBytes(), workingStorageBytes(samples); got != want {
			t.Fatalf("samples%d actual%d admitted%d", samples, got, want)
		}
	}
	var previous int64
	for _, samples := range []int{1025, 1026, 2048, 441000, maximumWindowSamples} {
		bytes := workingStorageBytes(samples)
		if bytes < previous || bytes <= 0 || bytes > 256*1024*1024 {
			t.Fatalf("invalid bound samples%d bytes%d", samples, bytes)
		}
		previous = bytes
	}
	for _, samples := range []int{-1, 0, 1024, maximumWindowSamples + 1} {
		if workingStorageBytes(samples) != 0 {
			t.Fatal("invalid size admitted", samples)
		}
	}
	t.Logf("maximum fixed-window arrays%d bytes; static model%d bytes is separate", previous, modelBytes)
}
func TestRunnerValidationAndCanceledConstruction(t *testing.T) {
	if _, err := newWindowRunner(context.Background(), nil, 2053); err == nil {
		t.Fatal("unverified archive accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	archive := &weightArchive{tensors: make(map[string]tensorDescriptor, 1691)}
	for name := range expectedModelSchema() {
		archive.tensors[name] = tensorDescriptor{}
	}
	if _, err := newWindowRunner(ctx, archive, 2053); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestTrainedRunnerProgressCancellationAndConcurrentAdmission(t *testing.T) {
	archive := actualArchive(t)
	runner, err := newWindowRunner(context.Background(), archive, 2053)
	if err != nil {
		t.Fatal(err)
	}
	left, right := make([]float32, 2053), make([]float32, 2053)
	consumed := false
	consume := func(_ int, l, r []float32) error {
		consumed = true
		if len(l) != 2053 || len(r) != 2053 {
			t.Fatal("wrong borrowed output length")
		}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = runner.predict(ctx, left, right, []int{0}, consume, inferenceHooks{progress: func(completed, total int) {
		if total != 28 {
			t.Errorf("wrong total%d", total)
		}
		if completed == 1 {
			cancel()
		}
	}})
	if !errors.Is(err, context.Canceled) || consumed {
		t.Fatal("canceled inference emitted output", err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	firstCtx, firstCancel := context.WithCancel(context.Background())
	defer firstCancel()
	go func() {
		result <- runner.predict(firstCtx, left, right, []int{0}, consume, inferenceHooks{progress: func(completed, _ int) {
			if completed == 0 {
				close(entered)
				<-release
				firstCancel()
			}
		}})
	}()
	<-entered
	secondCtx, secondCancel := context.WithCancel(context.Background())
	secondCancel()
	err = runner.predict(secondCtx, left, right, []int{0}, consume, inferenceHooks{})
	close(release)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("waiting admission ignored cancellation", err)
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal("first admission ignored cancellation", err)
	}
	for _, heads := range [][]int{{}, {0, 0}, {-1}, {5}, {0, 1, 2, 3, 4, 5}} {
		if err := runner.predict(context.Background(), left, right, heads, consume, inferenceHooks{}); err == nil {
			t.Fatal("invalid heads accepted", heads)
		}
	}
	completed := 0
	err = runner.predict(context.Background(), left, right, []int{0}, func(_ int, l, r []float32) error {
		consumed = true
		for i := range l {
			if l[i] != 0 || r[i] != 0 {
				t.Fatal("silent source produced trained PCM")
			}
		}
		return nil
	}, inferenceHooks{progress: func(step, total int) {
		if step != completed || total != 28 {
			t.Errorf("unexpected progress%d want%d total%d", step, completed, total)
		}
		completed++
	}})
	if err != nil || !consumed || completed != 29 {
		t.Fatal("runner was not reusable after cancellation", err, completed)
	}
}
