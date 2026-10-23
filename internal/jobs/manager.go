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
	// KindAnalyzeFeatures measures spectra and neutral change points without proposing processing.
	KindAnalyzeFeatures Kind = "analyze_features"
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
	ID        string                      `json:"jobId"`
	JobID     string                      `json:"job_id"`
	Kind      Kind                        `json:"kind"`
	Status    Status                      `json:"status"`
	Progress  int                         `json:"progress"`
	Stage     string                      `json:"stage"`
	Profile   string                      `json:"profile,omitempty"`
	StemCount int                         `json:"stemCount,omitempty"`
	Error     string                      `json:"error,omitempty"`
	Detail    string                      `json:"detail,omitempty"`
	CreatedAt time.Time                   `json:"createdAt"`
	UpdatedAt time.Time                   `json:"updatedAt"`
	Script    *mastering.Script           `json:"script,omitempty"`
	Features  *mastering.AnalysisFeatures `json:"features,omitempty"`
	Stems     []StemDescriptor            `json:"stems,omitempty"`

	stemWAVs      map[string][]byte
	cancel        context.CancelFunc
	reservedBytes int64
}

type workItem struct {
	jobID string
	run   func(ctx context.Context)
}

// Manager coordinates bounded worker goroutines and in-memory job state.
type Manager struct {
	mu        sync.RWMutex
	jobs      map[string]*Job
	queue     chan workItem
	closed    bool
	wg        sync.WaitGroup
	baseCtx   context.Context
	stopFn    context.CancelFunc
	usedBytes int64
}

// MaxMemoryBytes bounds admitted inputs and retained encoded artifacts together.
const MaxMemoryBytes int64 = 256 * 1024 * 1024

// MaxRetainedJobs limits metadata and result retention independently of bytes.
const MaxRetainedJobs = 64

// Retention is the lifetime of completed, failed and canceled job records.
const Retention = 15 * time.Minute

// NewManager creates and starts a concurrent job manager with the given worker count.
func NewManager(workers int) *Manager {
	if workers <= 0 {
		workers = min(2, runtime.NumCPU())
	}
	workers = min(workers, 4)
	baseCtx, stopFn := context.WithCancel(context.Background())
	m := &Manager{
		jobs:    make(map[string]*Job),
		queue:   make(chan workItem, MaxRetainedJobs),
		baseCtx: baseCtx,
		stopFn:  stopFn,
	}
	for i := 0; i < workers; i++ {
		m.wg.Add(1)
		go m.workerLoop()
	}
	m.wg.Add(1)
	go m.reapLoop()
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
	m.mu.Lock()
	clear(m.jobs)
	m.usedBytes = 0
	m.mu.Unlock()
}

func (m *Manager) workerLoop() {
	defer m.wg.Done()
	for item := range m.queue {
		m.mu.RLock()
		j, exists := m.jobs[item.jobID]
		if !exists || j.Status == StatusCanceled || m.baseCtx.Err() != nil {
			m.mu.RUnlock()
			m.releaseReservation(item.jobID)
			continue
		}
		m.mu.RUnlock()

		ctx, cancel := context.WithTimeout(m.baseCtx, 2*time.Minute)
		m.mu.Lock()
		if j.Status == StatusCanceled {
			m.mu.Unlock()
			cancel()
			m.releaseReservation(item.jobID)
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
		m.releaseReservation(item.jobID)
	}
}

func (m *Manager) reapLoop() {
	defer m.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-m.baseCtx.Done():
			return
		case now := <-ticker.C:
			m.mu.Lock()
			m.pruneLocked(now)
			m.mu.Unlock()
		}
	}
}

func (m *Manager) pruneLocked(now time.Time) {
	for id, j := range m.jobs {
		if j.reservedBytes == 0 && now.Sub(j.UpdatedAt) >= Retention {
			m.usedBytes -= retainedBytes(j)
			delete(m.jobs, id)
		}
	}
}

func (m *Manager) releaseReservation(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j, ok := m.jobs[id]; ok && j.reservedBytes > 0 {
		m.usedBytes -= j.reservedBytes
		j.reservedBytes = 0
		m.usedBytes += retainedBytes(j)
		j.cancel = nil
	}
}

func (m *Manager) admitLocked(job *Job, buf *audio.Buffer, stemCount int) error {
	if m.closed {
		return errors.New("job manager is closed")
	}
	m.pruneLocked(time.Now())
	if buf == nil || buf.Frames < 1 || buf.Frames > audio.MaxDecodedFrames || len(buf.Left) != buf.Frames || len(buf.Right) != buf.Frames {
		return errors.New("invalid audio buffer")
	}
	// Reserve input stereo float PCM plus all simultaneously live float stem
	// buffers and encoded 16-bit artifacts. Deep rendering also needs a stereo
	// float output. Scratch/headroom covers metering history and small objects.
	bytesPerFrame := int64(16)
	if job.Kind == KindAnalyzeFeatures {
		bytesPerFrame = 8 // Input only; features and FFT scratch fit the reserved headroom.
	}
	if stemCount > 0 {
		bytesPerFrame = 8 + int64(stemCount)*12
	}
	reservation := int64(buf.Frames)*bytesPerFrame + int64(stemCount)*44 + 16*1024*1024
	if len(m.jobs) >= MaxRetainedJobs || reservation > MaxMemoryBytes-m.usedBytes {
		return ErrQueueFull
	}
	job.reservedBytes = reservation
	m.usedBytes += reservation
	m.jobs[job.ID] = job
	return nil
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
	if stemCount < 2 || stemCount > 6 {
		return nil, errors.New("stem count must be between 2 and 6")
	}
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
	if err := m.admitLocked(job, buf, stemCount); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)

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
		m.mu.Unlock()
		return snapshot, nil
	default:
		m.usedBytes -= job.reservedBytes
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
	if err := m.admitLocked(job, buf, 0); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)

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
		m.mu.Unlock()
		return snapshot, nil
	default:
		m.usedBytes -= job.reservedBytes
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
	if j.Status != StatusCanceled {
		if j.reservedBytes == 0 {
			m.usedBytes -= retainedBytes(j)
		}
		j.Status = StatusCanceled
		j.Stage = "Canceled"
		j.stemWAVs = nil
		j.Stems = nil
		j.Script = nil
		j.Features = nil
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
	if j.Features != nil {
		features := *j.Features
		features.Frames = append([]mastering.FeatureFrame(nil), j.Features.Frames...)
		features.Sections = append([]mastering.FeatureSection(nil), j.Features.Sections...)
		features.Warnings = append([]string{}, j.Features.Warnings...)
		cp.Features = &features
	}
	return &cp
}

func retainedBytes(job *Job) int64 {
	var bytes int64
	for _, wav := range job.stemWAVs {
		bytes += int64(len(wav))
	}
	return bytes + job.Features.StorageBytes()
}

// SubmitAnalyzeFeatures enqueues bounded measured analysis without rendering audio.
func (m *Manager) SubmitAnalyzeFeatures(buf *audio.Buffer) (*Job, error) {
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{ID: id, JobID: id, Kind: KindAnalyzeFeatures, Status: StatusQueued, Stage: "Queued for measured feature analysis", CreatedAt: now, UpdatedAt: now}
	m.mu.Lock()
	if err := m.admitLocked(job, buf, 0); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)
	work := workItem{jobID: id, run: func(ctx context.Context) {
		features, err := mastering.AnalyzeFeaturesContext(ctx, buf, func(pct int, stage string) { m.updateProgress(id, pct, stage) })
		if err != nil {
			if ctx.Err() != nil {
				m.markCanceled(id)
			} else {
				m.markFailed(id, err)
			}
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		current, ok := m.jobs[id]
		if !ok || current.Status == StatusCanceled {
			return
		}
		current.Features = features
		current.Status = StatusDone
		current.Progress = 100
		current.Stage = "Measured features ready"
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
