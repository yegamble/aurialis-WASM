package jobs

// cspell:words BLAS backpressure

import (
	"errors"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/steminfer"
)

// MaxProcessMemoryBytes bounds accounted working allocations across requests,
// queued/running jobs, retained results and the shared model. It is not an RSS cap.
const MaxProcessMemoryBytes int64 = 2 * 1024 * 1024 * 1024

// ModelMemoryAllowance covers the immutable F16 archive plus 16 MiB for its
// bounded header (1 MiB), 1691 tensor descriptors, schema and download buffers.
// F32 tensor widening and BLAS scratch already belong to each stem job estimate.
const ModelMemoryAllowance int64 = steminfer.ModelBytes + 16*1024*1024

// ErrMemoryCapacity reports aggregate working-allocation backpressure.
var ErrMemoryCapacity = errors.New("audio memory capacity is full; download or discard retained results, or wait for another audio job to finish")

// MemoryReservation owns request scratch under the manager's existing lock and
// accounting. It can be resized or atomically transferred into one admitted job.
type MemoryReservation struct {
	manager     *Manager
	bytes       int64
	transferred bool
	released    bool
	onRelease   func()
}

func (m *Manager) processBytesLocked() int64 {
	return m.usedBytes + m.stemUsedBytes + m.requestBytes + m.modelBytes
}

// ReserveMemory admits synchronous request work before its allocations occur.
func (m *Manager) ReserveMemory(bytes int64) (*MemoryReservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || bytes < 0 || bytes > MaxProcessMemoryBytes-m.processBytesLocked() {
		return nil, ErrMemoryCapacity
	}
	reservation := &MemoryReservation{manager: m, bytes: bytes}
	m.requestBytes += bytes
	return reservation, nil
}

// Resize changes a live reservation without temporarily double charging it.
func (r *MemoryReservation) Resize(bytes int64) error {
	m := r.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || r.released || r.transferred || bytes < 0 || bytes > MaxProcessMemoryBytes-(m.processBytesLocked()-r.bytes) {
		return ErrMemoryCapacity
	}
	m.requestBytes += bytes - r.bytes
	r.bytes = bytes
	return nil
}

// Release is idempotent. A transferred reservation is owned by its job instead.
func (r *MemoryReservation) Release() {
	if r == nil {
		return
	}
	m := r.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if r.released {
		return
	}
	r.released = true
	if !r.transferred {
		m.requestBytes -= r.bytes
	}
	r.bytes = 0
	if r.onRelease != nil {
		release := r.onRelease
		r.onRelease = nil
		release()
	}
}
func (m *Manager) transferCreditLocked(credits []*MemoryReservation) (*MemoryReservation, int64, error) {
	if len(credits) == 0 || (len(credits) == 1 && credits[0] == nil) {
		return nil, 0, nil
	}
	if len(credits) != 1 {
		return nil, 0, ErrMemoryCapacity
	}
	r := credits[0]
	if r.manager != m || r.released || r.transferred {
		return nil, 0, ErrMemoryCapacity
	}
	return r, r.bytes, nil
}
func (m *Manager) rollbackAdmissionLocked(job *Job, credits []*MemoryReservation) {
	*m.pool(job) -= job.reservedBytes
	delete(m.jobs, job.ID)
	if len(credits) == 1 && credits[0] != nil {
		r := credits[0]
		m.requestBytes += r.bytes
		r.transferred = false
	}
}

func pcmExtraCapacity(buf *audio.Buffer) int64 {
	return int64(cap(buf.Left)+cap(buf.Right)-2*buf.Frames) * 4
}
