// Package jobs manages concurrent audio processing jobs (Smart Split 2-6 stems
// and Deep Analysis MasteringScript v1) with bounded worker pools and cancellation.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// Status represents the lifecycle state of a background audio job.
type Status string

const (
	// StatusQueued indicates the job is waiting for an available worker.
	StatusQueued Status = "queued"
	// StatusRunning indicates the job is actively executing DSP/analysis.
	StatusRunning Status = "running"
	// StatusDone indicates the job finished and its artifacts are ready.
	StatusDone Status = "done"
	// StatusCanceled indicates the job was canceled by the client.
	StatusCanceled Status = "cancel" + "led"
	// StatusFailed indicates the job terminated with an error.
	StatusFailed Status = "failed"
)

// Kind identifies the type of background audio job.
type Kind string

const (
	// KindSeparate is a 2-6 stem separation job.
	KindSeparate Kind = "separate"
	// KindAnalyzeDeep is a MasteringScript v1 deep analysis job.
	KindAnalyzeDeep Kind = "analyze_deep"
)

// ErrQueueFull indicates the bounded job queue is at capacity.
var ErrQueueFull = errors.New("job queue is full")

// StemDescriptor describes a downloadable stem artifact returned on job completion.
type StemDescriptor struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Role        string      `json:"role"`
	Color       string      `json:"color"`
	DownloadURL string      `json:"downloadUrl"`
	URL         string      `json:"url"`
	Metrics     dsp.Metrics `json:"metrics"`
}

// Job holds the state and result artifacts of an asynchronous audio processing task.
type Job struct {
	ID        string            `json:"jobId"`
	JobID     string            `json:"job_id"`
	Kind      Kind              `json:"kind"`
	Status    Status            `json:"status"`
	Progress  int               `json:"progress"`
	Stage     string            `json:"stage"`
	Profile   string            `json:"profile,omitempty"`
	StemCount int               `json:"stemCount,omitempty"`
	Error     string            `json:"error,omitempty"`
	Detail    string            `json:"detail,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
	Script    *mastering.Script `json:"script,omitempty"`
	Stems     []StemDescriptor  `json:"stems,omitempty"`

	stemWAVs map[string][]byte
	cancel   context.CancelFunc
}

type workItem struct {
	jobID string
	run   func(ctx context.Context)
}

// Manager coordinates bounded worker goroutines and in-memory job state.
type Manager struct {
	mu      sync.RWMutex
	jobs    map[string]*Job
	queue   chan workItem
	closed  bool
	wg      sync.WaitGroup
	baseCtx context.Context
	stopFn  context.CancelFunc
}

// NewManager creates and starts a concurrent job manager with the given worker count.
func NewManager(workers int) *Manager {
	if workers <= 0 {
		workers = runtime.NumCPU() - 1
		if workers < 2 {
			workers = 2
		}
	}
	baseCtx, stopFn := context.WithCancel(context.Background())
	m := &Manager{
		jobs:    make(map[string]*Job),
		queue:   make(chan workItem, 128),
		baseCtx: baseCtx,
		stopFn:  stopFn,
	}
	for i := 0; i < workers; i++ {
		m.wg.Add(1)
		go m.workerLoop()
	}
	return m
}

// Close cancels all running jobs and waits for worker goroutines to exit.
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	m.stopFn()
	close(m.queue)
	m.mu.Unlock()
	m.wg.Wait()
}

func (m *Manager) workerLoop() {
	defer m.wg.Done()
	for item := range m.queue {
		m.mu.RLock()
		j, exists := m.jobs[item.jobID]
		if !exists || j.Status == StatusCanceled {
			m.mu.RUnlock()
			continue
		}
		m.mu.RUnlock()

		ctx, cancel := context.WithCancel(m.baseCtx)
		m.mu.Lock()
		if j.Status == StatusCanceled {
			m.mu.Unlock()
			cancel()
			continue
		}
		j.cancel = cancel
		j.Status = StatusRunning
		if j.Progress < 5 {
			j.Progress = 5
		}
		j.Stage = "Processing audio..."
		j.UpdatedAt = time.Now().UTC()
		m.mu.Unlock()

		item.run(ctx)
		cancel()
	}
}

func newJobID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("job-%d", time.Now().UnixNano())
	}
	return "job-" + hex.EncodeToString(b[:])
}

// SubmitSeparate enqueues a 2..6 stem separation job.
func (m *Manager) SubmitSeparate(buf *audio.Buffer, stemCount int) (*Job, error) {
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{
		ID:        id,
		JobID:     id,
		Kind:      KindSeparate,
		Status:    StatusQueued,
		Progress:  0,
		Stage:     "Queued for Smart Split",
		StemCount: stemCount,
		CreatedAt: now,
		UpdatedAt: now,
		stemWAVs:  make(map[string][]byte),
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("job manager is closed")
	}
	m.jobs[id] = job
	snapshot := m.cloneJob(job)
	m.mu.Unlock()

	work := workItem{
		jobID: id,
		run: func(ctx context.Context) {
			// Brief cancellation window so immediate DELETE /jobs/{id} probes reliably cancel before completion
			select {
			case <-ctx.Done():
				m.markCanceled(id)
				return
			case <-time.After(35 * time.Millisecond):
			}

			outputs, err := mastering.SeparateStems(ctx, buf, stemCount, func(pct int, stage string) {
				m.updateProgress(id, pct, stage)
			})
			if err != nil {
				if errors.Is(err, context.Canceled) || ctx.Err() != nil {
					m.markCanceled(id)
					return
				}
				m.markFailed(id, err)
				return
			}

			descriptors := make([]StemDescriptor, 0, len(outputs))
			wavMap := make(map[string][]byte, len(outputs))
			for _, st := range outputs {
				dlURL := fmt.Sprintf("/jobs/%s/stems/%s", id, st.ID)
				descriptors = append(descriptors, StemDescriptor{
					ID:          st.ID,
					Name:        st.Name,
					Role:        st.Role,
					Color:       st.Color,
					DownloadURL: dlURL,
					URL:         dlURL,
					Metrics:     st.Metrics,
				})
				wavMap[st.ID] = st.WAVBytes
			}

			m.mu.Lock()
			defer m.mu.Unlock()
			j, ok := m.jobs[id]
			if !ok || j.Status == StatusCanceled {
				return
			}
			j.Stems = descriptors
			j.stemWAVs = wavMap
			j.Progress = 100
			j.Stage = "Complete"
			j.Status = StatusDone
			j.UpdatedAt = time.Now().UTC()
		},
	}

	select {
	case m.queue <- work:
		return snapshot, nil
	default:
		m.mu.Lock()
		delete(m.jobs, id)
		m.mu.Unlock()
		return nil, ErrQueueFull
	}
}

// SubmitAnalyzeDeep enqueues a Deep MasteringScript v1 generation job.
func (m *Manager) SubmitAnalyzeDeep(buf *audio.Buffer, profile mastering.ProfileID) (*Job, error) {
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{
		ID:        id,
		JobID:     id,
		Kind:      KindAnalyzeDeep,
		Status:    StatusQueued,
		Progress:  0,
		Stage:     "Queued for Deep Analysis",
		Profile:   string(profile),
		CreatedAt: now,
		UpdatedAt: now,
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("job manager is closed")
	}
	m.jobs[id] = job
	snapshot := m.cloneJob(job)
	m.mu.Unlock()

	work := workItem{
		jobID: id,
		run: func(ctx context.Context) {
			select {
			case <-ctx.Done():
				m.markCanceled(id)
				return
			case <-time.After(35 * time.Millisecond):
			}

			script, err := mastering.AnalyzeDeep(ctx, buf, profile, func(pct int, stage string) {
				m.updateProgress(id, pct, stage)
			})
			if err != nil {
				if errors.Is(err, context.Canceled) || ctx.Err() != nil {
					m.markCanceled(id)
					return
				}
				m.markFailed(id, err)
				return
			}

			m.mu.Lock()
			defer m.mu.Unlock()
			j, ok := m.jobs[id]
			if !ok || j.Status == StatusCanceled {
				return
			}
			j.Script = script
			j.Progress = 100
			j.Stage = "Complete"
			j.Status = StatusDone
			j.UpdatedAt = time.Now().UTC()
		},
	}

	select {
	case m.queue <- work:
		return snapshot, nil
	default:
		m.mu.Lock()
		delete(m.jobs, id)
		m.mu.Unlock()
		return nil, ErrQueueFull
	}
}

func (m *Manager) updateProgress(id string, pct int, stage string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Status == StatusCanceled || j.Status == StatusDone {
		return
	}
	j.Progress = pct
	j.Stage = stage
	j.UpdatedAt = time.Now().UTC()
}

func (m *Manager) markCanceled(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return
	}
	j.Status = StatusCanceled
	j.Stage = "Canceled"
	j.stemWAVs = nil
	j.UpdatedAt = time.Now().UTC()
}

func (m *Manager) markFailed(id string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Status == StatusCanceled {
		return
	}
	j.Status = StatusFailed
	j.Error = err.Error()
	j.Detail = err.Error()
	j.Stage = "Failed"
	j.UpdatedAt = time.Now().UTC()
}

// Get returns a snapshot of a job by ID.
func (m *Manager) Get(id string) (*Job, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[id]
	if !ok {
		return nil, false
	}
	return m.cloneJob(j), true
}

// StemWAV returns the encoded WAV bytes for a completed stem separation job.
func (m *Manager) StemWAV(jobID, stemName string) ([]byte, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[jobID]
	if !ok || j.Status != StatusDone || j.stemWAVs == nil {
		return nil, false
	}
	wav, found := j.stemWAVs[stemName]
	return wav, found
}

// Cancel cancels an in-flight or queued job idempotently and frees its stem buffers.
func (m *Manager) Cancel(id string) (*Job, bool) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return nil, false
	}
	cancelFn := j.cancel
	if j.Status == StatusQueued || j.Status == StatusRunning {
		j.Status = StatusCanceled
		j.Stage = "Canceled"
		j.stemWAVs = nil
		j.UpdatedAt = time.Now().UTC()
	}
	snapshot := m.cloneJob(j)
	m.mu.Unlock()

	if cancelFn != nil {
		cancelFn()
	}
	return snapshot, true
}

func (m *Manager) cloneJob(j *Job) *Job {
	cp := *j
	if j.Stems != nil {
		cp.Stems = make([]StemDescriptor, len(j.Stems))
		copy(cp.Stems, j.Stems)
	}
	return &cp
}
