package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// MaxReferenceResultBytes charges bounded retained proposal metadata independently of PCM.
const MaxReferenceResultBytes = 32 * 1024

func validReferenceGeometry(buf *audio.Buffer) bool {
	return buf != nil && buf.Frames >= 1 && buf.Frames <= audio.MaxDecodedFrames && len(buf.Left) == buf.Frames && len(buf.Right) == buf.Frames && buf.SampleRate >= 8000 && buf.SampleRate <= 192000 && buf.Channels == 2
}

func (m *Manager) admitReferenceLocked(job *Job, source, reference *audio.Buffer, credits ...*MemoryReservation) error {
	if !validReferenceGeometry(source) || !validReferenceGeometry(reference) {
		return errors.New("invalid source or reference geometry")
	}
	// Both inputs and bounded streaming render/FFT/result
	// headroom are charged in one lock transaction. No independent admissions can race.
	reservation := int64(source.Frames)*8 + int64(reference.Frames)*8 + 32*1024*1024 + pcmExtraCapacity(source) + pcmExtraCapacity(reference)
	return m.admitReservationLocked(job, reservation, credits...)
}

// SubmitAnalyzeReference admits both reconstructed sources and output scratch atomically.
func (m *Manager) SubmitAnalyzeReference(source, reference *audio.Buffer, baseline dsp.Params, options mastering.ReferenceOptions, credits ...*MemoryReservation) (*Job, error) {
	if err := dsp.ValidateParams(baseline); err != nil {
		return nil, err
	}
	if err := mastering.ValidateReferenceOptions(options); err != nil {
		return nil, err
	}
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{ID: id, JobID: id, Kind: KindAnalyzeReference, Status: StatusQueued, Stage: "Queued for measured reference EQ proposal", CreatedAt: now, UpdatedAt: now}
	m.mu.Lock()
	if err := m.admitReferenceLocked(job, source, reference, credits...); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)
	work := workItem{jobID: id, run: func(ctx context.Context) {
		result, err := mastering.MatchReferenceContext(ctx, source, reference, baseline, options, func(progress int, stage string) { m.updateProgress(id, progress, stage) })
		if err != nil {
			if ctx.Err() != nil {
				m.markCanceled(id)
			} else {
				m.markFailed(id, err)
			}
			return
		}
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > MaxReferenceResultBytes {
			m.markFailed(id, errors.New("reference proposal exceeds retained result bounds"))
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		current, ok := m.jobs[id]
		if !ok || current.Status == StatusCanceled {
			return
		}
		current.ReferenceProposal = result
		current.Status = StatusDone
		current.Progress = 100
		current.Stage = "Measured reference EQ proposal ready for review"
		current.UpdatedAt = time.Now().UTC()
	}}
	select {
	case m.queue <- work:
		m.mu.Unlock()
		return snapshot, nil
	default:
		m.rollbackAdmissionLocked(job, credits)
		m.mu.Unlock()
		return nil, ErrQueueFull
	}
}
