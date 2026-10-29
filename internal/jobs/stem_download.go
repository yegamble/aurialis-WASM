package jobs

import "github.com/yegamble/Aurialis-WASM/internal/audio"

// StemWAVResponse holds encoded bytes and pins their source until the HTTP
// writer releases ownership, including when cancellation removes the job UI.
type StemWAVResponse struct {
	Bytes  []byte
	memory *MemoryReservation
}

// Release returns encoded memory and the retained source pin exactly once.
func (r *StemWAVResponse) Release() { r.memory.Release() }

// LeaseStemWAV admits encoding before allocating it. Retained PCM is charged
// once to its existing job, and cancellation cannot release the charge for it while pinned.
func (m *Manager) LeaseStemWAV(jobID, stemName string) (*StemWAVResponse, bool, error) {
	m.mu.Lock()
	job, ok := m.jobs[jobID]
	if !ok || job.Status != StatusDone {
		m.mu.Unlock()
		return nil, false, nil
	}
	stem, ok := job.stemPCM[stemName]
	if !ok {
		m.mu.Unlock()
		return nil, false, nil
	}
	bytes := int64(len(stem.left))*6 + 44
	if m.closed || bytes > MaxProcessMemoryBytes-m.processBytesLocked() {
		m.mu.Unlock()
		return nil, false, ErrMemoryCapacity
	}
	job.downloadPins++
	memory := &MemoryReservation{manager: m, bytes: bytes, onRelease: func() {
		job.downloadPins--
		if m.jobs[jobID] == job && job.downloadPins == 0 && job.Status == StatusCanceled {
			if job.reservedBytes == 0 {
				*m.pool(job) -= retainedBytes(job)
			}
			job.stemPCM = nil
		}
	}}
	m.requestBytes += bytes
	m.mu.Unlock()
	wav, err := audio.EncodeWAV(stem.left, stem.right, stem.rate, stemBitDepth)
	if err != nil {
		memory.Release()
		return nil, false, err
	}
	return &StemWAVResponse{Bytes: wav, memory: memory}, true, nil
}
