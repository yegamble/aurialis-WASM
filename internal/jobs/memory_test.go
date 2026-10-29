package jobs

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/steminfer"
)

func TestProcessMemorySharesModelJobsAndRequests(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	if ModelMemoryAllowance < steminfer.ModelBytes+1024*1024 {
		t.Fatal("model header not covered")
	}
	separate := func(context.Context, int, int, []float32, []float32, func(int, int, []float32, []float32) error, func(float64)) error {
		return nil
	}
	if err := m.SetSeparator(separate); err != nil {
		t.Fatal(err)
	}
	request, err := m.ReserveMemory(MaxProcessMemoryBytes - ModelMemoryAllowance - MaxMemoryBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer request.Release()
	job := &Job{ID: "threshold", Kind: KindAnalyzeFeatures}
	m.mu.Lock()
	err = m.admitReservationLocked(job, MaxMemoryBytes)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.ReserveMemory(1); !errors.Is(err, ErrMemoryCapacity) {
		t.Fatal("aggregate threshold not enforced", err)
	}
	m.mu.Lock()
	m.rollbackAdmissionLocked(job, nil)
	m.mu.Unlock()
	if err = request.Resize(MaxProcessMemoryBytes - ModelMemoryAllowance); err != nil {
		t.Fatal(err)
	}
	if err = request.Resize(MaxProcessMemoryBytes - ModelMemoryAllowance + 1); !errors.Is(err, ErrMemoryCapacity) {
		t.Fatal("resize exceeded threshold")
	}
}
func TestModelInstallationCannotExceedProcessMemory(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	r, err := m.ReserveMemory(MaxProcessMemoryBytes - ModelMemoryAllowance + 1)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Release()
	if err = m.SetSeparator(func(context.Context, int, int, []float32, []float32, func(int, int, []float32, []float32) error, func(float64)) error {
		return nil
	}); !errors.Is(err, ErrMemoryCapacity) {
		t.Fatal("model exceeded aggregate budget", err)
	}
}
func TestRequestCreditTransfersAtomicallyWithoutDoubleCharge(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	lease, err := m.ReserveMemory(MaxMemoryBytes)
	if err != nil {
		t.Fatal(err)
	}
	other, err := m.ReserveMemory(MaxProcessMemoryBytes - MaxMemoryBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Release()
	job := &Job{ID: "transfer", Kind: KindAnalyzeFeatures}
	m.mu.Lock()
	err = m.admitReservationLocked(job, MaxMemoryBytes, lease)
	total := m.processBytesLocked()
	m.mu.Unlock()
	if err != nil || total != MaxProcessMemoryBytes {
		t.Fatal("credit counted twice", err, total)
	}
	lease.Release()
	lease.Release()
	m.releaseReservation(job.ID)
	m.mu.Lock()
	total = m.processBytesLocked()
	m.mu.Unlock()
	if total != MaxProcessMemoryBytes-MaxMemoryBytes {
		t.Fatalf("job release retained %d", total)
	}
}
func TestReservationFailureAndRollbackRetainRequestOwnership(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	lease, err := m.ReserveMemory(100)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	job := &Job{ID: "rollback", Kind: KindAnalyzeFeatures}
	m.mu.Lock()
	err = m.admitReservationLocked(job, 200, lease)
	if err == nil {
		m.rollbackAdmissionLocked(job, []*MemoryReservation{lease})
	}
	total := m.processBytesLocked()
	m.mu.Unlock()
	if err != nil || total != 100 || lease.transferred {
		t.Fatalf("rollback lost ownership: %v total%d", err, total)
	}
}
func TestMemoryReservationConcurrentCancelReleaseAndResize(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	for range 20 {
		lease, err := m.ReserveMemory(1024)
		if err != nil {
			t.Fatal(err)
		}
		var group sync.WaitGroup
		group.Go(func() {
			for range 20 {
				_ = lease.Resize(2048)
			}
		})
		group.Go(func() { lease.Release() })
		group.Go(func() { lease.Release() })
		group.Wait()
	}
	m.mu.Lock()
	total := m.processBytesLocked()
	m.mu.Unlock()
	if total != 0 {
		t.Fatalf("leaked %d bytes", total)
	}
}
func TestStemDownloadPinsPCMThroughCancel(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	job := &Job{ID: "download", Kind: KindSeparate, Status: StatusDone, UpdatedAt: time.Now(), stemPCM: map[string]stemAudio{"vocals": {left: make([]float32, 16), right: make([]float32, 16), rate: 48000}}}
	m.mu.Lock()
	m.jobs[job.ID] = job
	m.stemUsedBytes = retainedBytes(job)
	m.mu.Unlock()
	response, ok, err := m.LeaseStemWAV(job.ID, "vocals")
	if err != nil || !ok {
		t.Fatal(err)
	}
	m.Cancel(job.ID)
	m.mu.Lock()
	total := m.processBytesLocked()
	m.mu.Unlock()
	if total != 16*8+16*6+44 {
		t.Fatalf("download source uncharged early: %d", total)
	}
	response.Release()
	response.Release()
	m.mu.Lock()
	total = m.processBytesLocked()
	m.mu.Unlock()
	if total != 0 {
		t.Fatalf("download retained %d", total)
	}
}
func TestProcessAdmissionIncludesRetainedFLACCapacity(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	buf := &audio.Buffer{SampleRate: 48000, Frames: 8, Channels: 2, Left: make([]float32, 8, 16), Right: make([]float32, 8, 16)}
	job := &Job{ID: "capacity", Kind: KindAnalyzeFeatures}
	m.mu.Lock()
	err := m.admitLocked(job, buf)
	got := job.reservedBytes
	m.mu.Unlock()
	if err != nil || got != 16*8+16*1024*1024 {
		t.Fatalf("capacity was lost: %d %v", got, err)
	}
}

func TestStemDownloadReleaseAndCancellationRace(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	for range 20 {
		job := &Job{ID: newJobID(), Kind: KindSeparate, Status: StatusDone, UpdatedAt: time.Now(), stemPCM: map[string]stemAudio{"vocals": {left: make([]float32, 16), right: make([]float32, 16), rate: 48000}}}
		m.mu.Lock()
		m.jobs[job.ID] = job
		m.stemUsedBytes += retainedBytes(job)
		m.mu.Unlock()
		response, ok, err := m.LeaseStemWAV(job.ID, "vocals")
		if err != nil || !ok {
			t.Fatal(err)
		}
		var group sync.WaitGroup
		group.Go(func() { m.Cancel(job.ID) })
		group.Go(response.Release)
		group.Wait()
	}
	m.mu.Lock()
	total := m.processBytesLocked()
	m.mu.Unlock()
	if total != 0 {
		t.Fatalf("cancel/download race retained%d bytes", total)
	}
}
func TestNormalAndStemCategoryLimitsShareOneProcessCeiling(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	if err := m.SetSeparator(func(context.Context, int, int, []float32, []float32, func(int, int, []float32, []float32) error, func(float64)) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.admitReservationLocked(&Job{ID: "normal", Kind: KindAnalyzeFeatures}, MaxMemoryBytes); err != nil {
		t.Fatal(err)
	}
	if err := m.admitReservationLocked(&Job{ID: "stems", Kind: KindSeparate}, MaxSeparationBytes); !errors.Is(err, ErrMemoryCapacity) {
		t.Fatal("separate pools bypass aggregate limit", err)
	}
}

func TestJobSnapshotsDoNotRetainPrivateAudio(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	job := &Job{ID: "snapshot", Kind: KindSeparate, Status: StatusDone, stemPCM: map[string]stemAudio{"vocals": {left: make([]float32, 16), right: make([]float32, 16), rate: 48000}}}
	m.mu.Lock()
	snapshot := m.cloneJob(job)
	m.mu.Unlock()
	if snapshot.stemPCM != nil || snapshot.cancel != nil {
		t.Fatal("public snapshot retained private audio")
	}
}

func TestStemDownloadCapacityFailureLeavesNoPin(t *testing.T) {
	m := NewManager(1)
	defer m.Close()
	job := &Job{ID: "full-download", Kind: KindSeparate, Status: StatusDone, stemPCM: map[string]stemAudio{"vocals": {left: make([]float32, 16), right: make([]float32, 16), rate: 48000}}}
	m.mu.Lock()
	m.jobs[job.ID] = job
	m.stemUsedBytes = retainedBytes(job)
	m.mu.Unlock()
	held, err := m.ReserveMemory(MaxProcessMemoryBytes - 16*8 - (16*6 + 44) + 1)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	if _, ok, err := m.LeaseStemWAV(job.ID, "vocals"); ok || !errors.Is(err, ErrMemoryCapacity) {
		t.Fatal("download bypassed capacity", err)
	}
	m.mu.Lock()
	pins := job.downloadPins
	m.mu.Unlock()
	if pins != 0 {
		t.Fatal("failed download retained a source pin")
	}
}
