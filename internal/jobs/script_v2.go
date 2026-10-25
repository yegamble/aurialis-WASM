package jobs

import (
	"context"
	"encoding/json"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// SubmitAnalyzeDeepV2 admits a bounded measured proposal job without rendering output PCM.
func (m *Manager) SubmitAnalyzeDeepV2(buf *audio.Buffer, profile mastering.ProfileID) (*Job, error) {
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{ID: id, JobID: id, Kind: KindAnalyzeDeepV2, Status: StatusQueued, Stage: "Queued for measured ScriptV2 proposal", Profile: string(profile), CreatedAt: now, UpdatedAt: now}
	m.mu.Lock()
	if err := m.admitLocked(job, buf); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)
	work := workItem{jobID: id, run: func(ctx context.Context) {
		script, err := mastering.AnalyzeDeepV2Context(ctx, buf, profile, func(progress int, stage string) { m.updateProgress(id, progress, stage) })
		if err != nil {
			if ctx.Err() != nil {
				m.markCanceled(id)
			} else {
				m.markFailed(id, err)
			}
			return
		}
		// Enforce the retained result bound before taking the manager lock.
		encoded, err := json.Marshal(script)
		if err != nil || len(encoded) > mastering.MaxScriptV2Bytes {
			m.markFailed(id, mastering.ErrScriptV2Storage)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		current, ok := m.jobs[id]
		if !ok || current.Status == StatusCanceled {
			return
		}
		current.ScriptV2 = script
		current.Status = StatusDone
		current.Progress = 100
		current.Stage = "Measured proposal ready for review"
		current.UpdatedAt = time.Now().UTC()
	}}
	select {
	case m.queue <- work:
		m.mu.Unlock()
		return snapshot, nil
	default:
		m.usedBytes -= job.reservedBytes
		delete(m.jobs, id)
		m.mu.Unlock()
		return nil, ErrQueueFull
	}
}
