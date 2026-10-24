package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

func pressureSource() *audio.Buffer {
	return &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 16, Left: make([]float32, 16), Right: make([]float32, 16)}
}

func TestCanceledJobRecordsYieldToOrdinaryWorkAtCapacity(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	var oldest, newest string
	for index := range MaxRetainedJobs {
		submitted, err := manager.SubmitAnalyzeFeatures(pressureSource())
		if err != nil {
			t.Fatalf("ordinary job %d was refused: %v", index, err)
		}
		waitFeatures(t, manager, submitted.ID)
		for range 2 {
			canceled, ok := manager.Cancel(submitted.ID)
			if !ok || canceled.Status != StatusCanceled || canceled.Features != nil {
				t.Fatal("DELETE did not retain its idempotent canceled receipt")
			}
		}
		if index == 0 {
			oldest = submitted.ID
		}
		newest = submitted.ID
	}
	manager.mu.RLock()
	count, used := len(manager.jobs), manager.usedBytes
	manager.mu.RUnlock()
	if count != MaxRetainedJobs || used != 0 {
		t.Fatalf("expected 64 settled canceled records and zero audio bytes: count%d used%d", count, used)
	}
	next, err := manager.SubmitAnalyzeFeatures(pressureSource())
	if err != nil {
		t.Fatalf("65th ordinary operation was locked out by already-deleted records: %v", err)
	}
	waitFeatures(t, manager, next.ID)
	if _, ok := manager.Get(oldest); ok {
		t.Fatal("oldest settled tombstone did not yield under pressure")
	}
	if current, ok := manager.Get(newest); !ok || current.Status != StatusCanceled {
		t.Fatal("newer cancellation receipt disappeared unnecessarily")
	}
	manager.mu.RLock()
	count = len(manager.jobs)
	manager.mu.RUnlock()
	if count != MaxRetainedJobs {
		t.Fatalf("retained record cap changed: %d", count)
	}
}

func TestPressureKeepsCanceledWorkerOwnershipUntilActualSettlement(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	retained := make([]string, 0, MaxRetainedJobs-1)
	for range MaxRetainedJobs - 1 {
		submitted, err := manager.SubmitAnalyzeFeatures(pressureSource())
		if err != nil {
			t.Fatal(err)
		}
		waitFeatures(t, manager, submitted.ID)
		retained = append(retained, submitted.ID)
	}
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	settle := func() { once.Do(func() { close(release) }) }
	defer settle()
	owner := &Job{ID: "held-worker", JobID: "held-worker", Kind: KindAnalyzeFeatures, Status: StatusQueued, UpdatedAt: time.Now()}
	manager.mu.Lock()
	err := manager.admitReservationLocked(owner, 32)
	manager.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	manager.queue <- workItem{jobID: owner.ID, run: func(ctx context.Context) { close(started); <-ctx.Done(); close(canceled); <-release }}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	manager.Cancel(owner.ID)
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not observe cancellation")
	}
	manager.mu.RLock()
	held := manager.jobs[owner.ID].reservedBytes
	manager.mu.RUnlock()
	if held != 32 {
		t.Fatal("cancellation released unsettled worker ownership")
	}
	if _, admission := manager.SubmitAnalyzeFeatures(pressureSource()); !errors.Is(admission, ErrQueueFull) {
		t.Fatalf("active canceled owner or unclaimed result was evicted: %v", admission)
	}
	settle()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.RLock()
		settled := manager.jobs[owner.ID].reservedBytes == 0
		manager.mu.RUnlock()
		if settled {
			break
		}
		time.Sleep(time.Millisecond)
	}
	next, admission := manager.SubmitAnalyzeFeatures(pressureSource())
	if admission != nil {
		t.Fatalf("settled canceled worker did not yield its metadata slot: %v", admission)
	}
	waitFeatures(t, manager, next.ID)
	for _, id := range retained {
		if job, ok := manager.Get(id); !ok || job.Status != StatusDone || job.Features == nil {
			t.Fatal("pressure discarded an unclaimed result")
		}
	}
	if _, ok := manager.Get(owner.ID); ok {
		t.Fatal("settled canceled owner remained instead of yielding")
	}
}

func TestInvalidPressureDemandDoesNotDiscardCancellationReceipts(t *testing.T) {
	for _, demand := range []int64{0, -1, MaxMemoryBytes + 1} {
		t.Run(fmt.Sprint(demand), func(t *testing.T) {
			manager := NewManager(1)
			defer manager.Close()
			manager.mu.Lock()
			for index := range MaxRetainedJobs {
				id := fmt.Sprintf("canceled-%02d", index)
				manager.jobs[id] = &Job{ID: id, Status: StatusCanceled, UpdatedAt: time.Now()}
			}
			admission := manager.admitReservationLocked(&Job{ID: "invalid"}, demand)
			count := len(manager.jobs)
			_, oldest := manager.jobs["canceled-00"]
			used := manager.usedBytes
			manager.mu.Unlock()
			if admission == nil || count != MaxRetainedJobs || !oldest || used != 0 {
				t.Fatal("invalid or unaffordable demand mutated retained cancellation receipts")
			}
		})
	}
}

func TestCanceledReceiptsRemainWithoutPressureAndTiesYieldDeterministically(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	stamp := time.Now().Add(-time.Second)
	manager.mu.Lock()
	for index := range MaxRetainedJobs - 1 {
		id := fmt.Sprintf("receipt-%02d", index)
		manager.jobs[id] = &Job{ID: id, Status: StatusCanceled, UpdatedAt: stamp}
	}
	manager.mu.Unlock()
	first, err := manager.SubmitAnalyzeFeatures(pressureSource())
	if err != nil {
		t.Fatal(err)
	}
	waitFeatures(t, manager, first.ID)
	for index := range MaxRetainedJobs - 1 {
		id := fmt.Sprintf("receipt-%02d", index)
		receipt, ok := manager.Cancel(id)
		if !ok || receipt.Status != StatusCanceled {
			t.Fatal("receipt was discarded without record pressure")
		}
	}
	next, err := manager.SubmitAnalyzeFeatures(pressureSource())
	if err != nil {
		t.Fatal(err)
	}
	waitFeatures(t, manager, next.ID)
	if _, ok := manager.Get("receipt-00"); ok {
		t.Fatal("equal-age cancellation receipts did not yield by stable identity")
	}
	if receipt, ok := manager.Get("receipt-01"); !ok || receipt.Status != StatusCanceled {
		t.Fatal("more than one cancellation receipt was discarded")
	}
	if result, ok := manager.Get(first.ID); !ok || result.Status != StatusDone || result.Features == nil {
		t.Fatal("pressure discarded an unclaimed result")
	}
	manager.mu.RLock()
	count := len(manager.jobs)
	manager.mu.RUnlock()
	if count != MaxRetainedJobs {
		t.Fatalf("retained record bound changed: %d", count)
	}
}
