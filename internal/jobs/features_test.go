// cspell:words RMSDB
package jobs

import (
	"errors"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

func waitFeatures(t *testing.T, manager *Manager, id string) *Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := manager.Get(id)
		if !ok {
			t.Fatal("job disappeared")
		}
		if job.Status == StatusFailed {
			t.Fatal(job.Error)
		}
		manager.mu.RLock()
		settled := manager.jobs[id].reservedBytes == 0
		manager.mu.RUnlock()
		if job.Status == StatusDone && settled {
			return job
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("feature job did not settle")
	return nil
}

func TestFeatureJobRetainsChargedImmutableSummariesAndPrunes(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 8000, Duration: 1, Left: make([]float32, 8000), Right: make([]float32, 8000)}
	submission, err := manager.SubmitAnalyzeFeatures(buf)
	if err != nil {
		t.Fatal(err)
	}
	job := waitFeatures(t, manager, submission.ID)
	if job.Kind != KindAnalyzeFeatures || job.Features == nil || job.Script != nil || len(job.Stems) != 0 {
		t.Fatal("feature analysis returned processing artifacts")
	}
	manager.mu.RLock()
	charged := manager.usedBytes
	retained := manager.jobs[job.ID].Features.StorageBytes()
	manager.mu.RUnlock()
	if charged <= 0 || charged != retained {
		t.Fatalf("retained feature storage uncharged: used%d want%d", charged, retained)
	}
	job.Features.Frames[0].RMSDB = 123
	job.Features.Sections[0].Name = "mutated"
	next, _ := manager.Get(job.ID)
	if next.Features.Frames[0].RMSDB == 123 || next.Features.Sections[0].Name == "mutated" {
		t.Fatal("snapshot mutations changed manager-owned features")
	}
	manager.mu.Lock()
	manager.jobs[job.ID].UpdatedAt = time.Now().Add(-Retention - time.Second)
	manager.pruneLocked(time.Now())
	if manager.usedBytes != 0 || len(manager.jobs) != 0 {
		t.Fatal("expired feature storage retained")
	}
	manager.mu.Unlock()
}

func TestFeatureJobCancellationReleasesActiveAndRetainedStorage(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 192000, Duration: 24, Left: make([]float32, 192000), Right: make([]float32, 192000)}
	for _, wait := range []bool{false, true} {
		submission, err := manager.SubmitAnalyzeFeatures(buf)
		if err != nil {
			t.Fatal(err)
		}
		if wait {
			waitFeatures(t, manager, submission.ID)
		}
		for range 2 {
			job, ok := manager.Cancel(submission.ID)
			if !ok || job.Status != StatusCanceled || job.Features != nil {
				t.Fatal("cancellation not idempotent or retained features")
			}
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			manager.mu.RLock()
			used := manager.usedBytes
			manager.mu.RUnlock()
			if used == 0 {
				break
			}
			time.Sleep(time.Millisecond)
		}
		manager.mu.RLock()
		used := manager.usedBytes
		manager.mu.RUnlock()
		if used != 0 {
			t.Fatalf("canceled feature storage=%d", used)
		}
	}
}

func TestFeatureJobAdmissionReservesInputScratchAndRetainedResults(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 16, Left: make([]float32, 16), Right: make([]float32, 16)}
	manager.mu.Lock()
	job := &Job{ID: "admitted", Kind: KindAnalyzeFeatures}
	err := manager.admitLocked(job, buf)
	if err != nil {
		manager.mu.Unlock()
		t.Fatal(err)
	}
	if want := int64(16*8 + 16*1024*1024); job.reservedBytes != want {
		manager.mu.Unlock()
		t.Fatalf("feature reservation%d want%d", job.reservedBytes, want)
	}
	manager.usedBytes = MaxMemoryBytes
	err = manager.admitLocked(&Job{ID: "rejected", Kind: KindAnalyzeFeatures}, buf)
	manager.mu.Unlock()
	if !errors.Is(err, ErrQueueFull) {
		t.Fatal("feature memory admission not enforced", err)
	}
}
