package jobs

import (
	"errors"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func referenceJobBuffer(frames int) *audio.Buffer {
	return &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: frames, Duration: float64(frames) / 8000, Left: make([]float32, frames), Right: make([]float32, frames)}
}

func TestReferenceJointReservationAndBounds(t *testing.T) {
	source, reference := referenceJobBuffer(8000), referenceJobBuffer(16000)
	manager := &Manager{jobs: map[string]*Job{}}
	expected := int64(8000*8 + 16000*8 + 32*1024*1024)
	manager.usedBytes = MaxMemoryBytes - expected + 1
	job := &Job{ID: "joint", Kind: KindAnalyzeReference}
	if err := manager.admitReferenceLocked(job, source, reference); !errors.Is(err, ErrQueueFull) || len(manager.jobs) != 0 {
		t.Fatal("joint admission exceeded memory cap", err)
	}
	manager.usedBytes = 0
	if err := manager.admitReferenceLocked(job, source, reference); err != nil || job.reservedBytes != expected || manager.usedBytes != expected {
		t.Fatal("joint input/render scratch undercharged", err)
	}
	invalid := *reference
	invalid.Frames++
	if err := manager.admitReferenceLocked(&Job{ID: "invalid"}, source, &invalid); err == nil {
		t.Fatal("invalid reference admitted")
	}
}

func TestReferenceJobSnapshotRetentionAndCancel(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	source := referenceJobBuffer(8000)
	job, err := manager.SubmitAnalyzeReference(source, source, dsp.DefaultParams(), mastering.ReferenceOptions{Amount: 0})
	if err != nil {
		t.Fatal(err)
	}
	result := waitFeatures(t, manager, job.ID)
	if result.Kind != KindAnalyzeReference || result.ReferenceProposal == nil || result.ReferenceProposal.Source != result.ReferenceProposal.Reference || result.ReferenceProposal.Params != dsp.DefaultParams() {
		t.Fatal("wrong reference result")
	}
	manager.mu.RLock()
	charged := manager.usedBytes
	manager.mu.RUnlock()
	if charged != MaxReferenceResultBytes {
		t.Fatal("retained result uncharged", charged)
	}
	result.ReferenceProposal.Warnings[0] = "mutated"
	next, _ := manager.Get(job.ID)
	if next.ReferenceProposal.Warnings[0] == "mutated" {
		t.Fatal("consumer mutated retained result")
	}
	manager.Cancel(job.ID)
	manager.mu.RLock()
	charged = manager.usedBytes
	manager.mu.RUnlock()
	if charged != 0 {
		t.Fatal("canceled retained result still charged", charged)
	}
	next, _ = manager.Get(job.ID)
	if next.ReferenceProposal != nil {
		t.Fatal("canceled proposal retained")
	}
}
