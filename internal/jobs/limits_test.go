package jobs

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func TestCloseAndSubmitAreRaceSafe(t *testing.T) {
	for range 10 {
		manager := NewManager(1)
		buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: 16, Left: make([]float32, 16), Right: make([]float32, 16)}
		var group sync.WaitGroup
		for range 20 {
			group.Go(func() { _, _ = manager.SubmitAnalyzeDeep(buf, mastering.ProfileWarmAnalog) })
		}
		group.Go(manager.Close)
		group.Wait()
		manager.Close()
		if manager.usedBytes != 0 || len(manager.jobs) != 0 {
			t.Fatal("shutdown retained job data")
		}
	}
}

func TestSeparationAdmissionUsesItsOwnPool(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	block := make(chan struct{})
	manager.SetSeparator(func(ctx context.Context, _, _ int, _, _ []float32, _ func(int, int, []float32, []float32) error, _ func(float64)) error {
		select {
		case <-block:
		case <-ctx.Done():
		}
		return ctx.Err()
	})
	defer close(block)
	// Two four-minute 48 kHz songs: the first fits, the second exceeds the pool.
	frames := 48000 * 240
	buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: frames, Left: make([]float32, frames), Right: make([]float32, frames)}
	job, err := manager.SubmitSeparate(buf, 6)
	if err != nil {
		t.Fatal(err)
	}
	want, err := separationReservation(buf, 6)
	if err != nil || job.reservedBytes != want || manager.stemUsedBytes != want || manager.usedBytes != 0 {
		t.Fatalf("reservation %d want %d (%v); stem pool %d general %d", job.reservedBytes, want, err, manager.stemUsedBytes, manager.usedBytes)
	}
	if _, err := manager.SubmitSeparate(buf, 6); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("second full-length separation admitted: %v", err)
	}
	// The general pool is untouched, so other jobs still run.
	if _, err := manager.SubmitAnalyzeFeatures(&audio.Buffer{SampleRate: 48000, Channels: 2, Frames: 16, Left: make([]float32, 16), Right: make([]float32, 16)}); err != nil {
		t.Fatal(err)
	}
	manager.Cancel(job.ID)
}

func TestSeparationWithoutSeparatorIsUnavailable(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: 16, Left: make([]float32, 16), Right: make([]float32, 16)}
	if _, err := manager.SubmitSeparate(buf, 4); !errors.Is(err, ErrSeparationUnavailable) {
		t.Fatalf("err %v", err)
	}
	if manager.stemUsedBytes != 0 || len(manager.jobs) != 0 {
		t.Fatal("rejected separation was retained")
	}
}

func TestExpiredArtifactsReleaseBudget(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	manager.mu.Lock()
	manager.jobs["expired"] = &Job{ID: "expired", Status: StatusDone, UpdatedAt: time.Now().Add(-Retention - time.Second), stemPCM: map[string]stemAudio{"vocals": {left: make([]float32, 25)}}}
	manager.usedBytes = 100
	manager.pruneLocked(time.Now())
	if manager.usedBytes != 0 || len(manager.jobs) != 0 {
		t.Fatal("expired artifacts retained")
	}
	manager.mu.Unlock()
}

func TestReservationIncludesInputAndOutput(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	const frames = 100
	buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: frames, Left: make([]float32, frames), Right: make([]float32, frames)}
	job := &Job{ID: newJobID()}
	manager.mu.Lock()
	err := manager.admitLocked(job, buf)
	manager.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if expected := int64(frames*16 + 16*1024*1024); job.reservedBytes != expected {
		t.Fatalf("reservation %d want %d", job.reservedBytes, expected)
	}
}
