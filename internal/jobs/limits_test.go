package jobs

import (
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

func TestAdmissionReservesInputAndOutputMemory(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	frames := int((MaxMemoryBytes - 16*1024*1024 - 6*44) / (8 + 6*12))
	buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: frames, Left: make([]float32, frames), Right: make([]float32, frames)}
	job, err := manager.SubmitSeparate(buf, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Cancel(job.ID)
	if _, err := manager.SubmitSeparate(buf, 6); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("unbounded admission err=%v", err)
	}
	manager.Cancel(job.ID)
}

func TestExpiredArtifactsReleaseBudget(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	manager.mu.Lock()
	manager.jobs["expired"] = &Job{ID: "expired", Status: StatusDone, UpdatedAt: time.Now().Add(-Retention - time.Second), stemWAVs: map[string][]byte{"vocals": make([]byte, 100)}}
	manager.usedBytes = 100
	manager.pruneLocked(time.Now())
	if manager.usedBytes != 0 || len(manager.jobs) != 0 {
		t.Fatal("expired artifacts retained")
	}
	manager.mu.Unlock()
}

func TestReservationIncludesLiveFloatStemsAndDeepOutput(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	const frames = 100
	buf := &audio.Buffer{SampleRate: 48000, Channels: 2, Frames: frames, Left: make([]float32, frames), Right: make([]float32, frames)}
	for _, stems := range []int{0, 2, 6} {
		job := &Job{ID: newJobID()}
		manager.mu.Lock()
		err := manager.admitLocked(job, buf, stems)
		manager.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		bytesPerFrame := int64(16)
		if stems > 0 {
			bytesPerFrame = 8 + int64(stems)*12
		}
		expected := frames*bytesPerFrame + int64(stems)*44 + 16*1024*1024
		if job.reservedBytes != expected {
			t.Fatalf("stems%d reservation %d want%d", stems, job.reservedBytes, expected)
		}
	}
}
