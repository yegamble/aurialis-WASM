package jobs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/audio/steminfer"
)

// SeparateFunc splits stereo PCM into stems, calling sink with each stem's
// samples in order and progress with the completed fraction. The server
// backs it with the trained model; tests substitute their own.
type SeparateFunc func(ctx context.Context, rate, stems int, left, right []float32, sink func(stem, start int, left, right []float32) error, progress func(float64)) error

// ErrSeparationUnavailable reports that no separator is configured.
var ErrSeparationUnavailable = errors.New("stem separation is not available in this build")

// MaxSeparationBytes bounds memory for separation jobs, apart from the model
// and the general job budget. One full-length song fits; a second waits.
const MaxSeparationBytes int64 = 1536 * 1024 * 1024

// MaxQueuedSeparations bounds separation jobs waiting behind the running one.
const MaxQueuedSeparations = 4

// SeparationTimeout bounds one separation. A 20 s model window takes about
// 30 s on an 8-core M2, so long songs take several minutes.
const SeparationTimeout = 90 * time.Minute

// stemBitDepth is the WAV depth of delivered stems.
const stemBitDepth = 24

type stemStyle struct{ name, color string }

var stemStyles = map[string]stemStyle{
	"vocals":       {"Vocals", "#b4543c"},
	"instrumental": {"Instrumental", "#596c52"},
	"drums":        {"Drums", "#596c52"},
	"rest":         {"Everything else", "#78638b"},
	"bass":         {"Bass", "#8a6529"},
	"melody":       {"Guitar & piano", "#4f7482"},
	"guitar":       {"Guitar", "#4f7482"},
	"piano":        {"Piano", "#936856"},
	"other":        {"Other", "#78638b"},
}

// SetSeparator installs the stem separator. Without one, SubmitSeparate
// returns ErrSeparationUnavailable.
func (m *Manager) SetSeparator(separate SeparateFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.separate = separate
}

type stemAudio struct {
	left, right []float32
	rate        int
}

// separationReservation is steminfer.JobBytes: the separator's working memory,
// the input copy and the float stems retained afterwards.
func separationReservation(buf *audio.Buffer, stems int) (int64, error) {
	return steminfer.JobBytes(buf.SampleRate, buf.Frames, stems)
}

// SubmitSeparate enqueues a 2..6 stem separation job.
func (m *Manager) SubmitSeparate(buf *audio.Buffer, stemCount int) (*Job, error) {
	names, err := steminfer.StemNames(stemCount)
	if err != nil {
		return nil, errors.New("stem count must be between 2 and 6")
	}
	if buf == nil || buf.Frames < 1 || buf.Frames > audio.MaxDecodedFrames || len(buf.Left) != buf.Frames || len(buf.Right) != buf.Frames {
		return nil, errors.New("invalid audio buffer")
	}
	reservation, err := separationReservation(buf, stemCount)
	if err != nil {
		return nil, fmt.Errorf("audio is too long to separate: %w", err)
	}
	id := newJobID()
	now := time.Now().UTC()
	job := &Job{
		ID: id, JobID: id, Kind: KindSeparate, Status: StatusQueued,
		Stage: "Queued for Smart Split", StemCount: stemCount,
		CreatedAt: now, UpdatedAt: now,
	}

	m.mu.Lock()
	separate := m.separate
	if separate == nil {
		m.mu.Unlock()
		return nil, ErrSeparationUnavailable
	}
	if err := m.admitReservationLocked(job, reservation); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	snapshot := m.cloneJob(job)
	work := workItem{jobID: id, run: func(ctx context.Context) {
		m.runSeparation(ctx, id, buf, names, separate)
	}}
	select {
	case m.stemQueue <- work:
		m.mu.Unlock()
		return snapshot, nil
	default:
		m.stemUsedBytes -= job.reservedBytes
		delete(m.jobs, id)
		m.mu.Unlock()
		return nil, ErrQueueFull
	}
}

func (m *Manager) runSeparation(ctx context.Context, id string, buf *audio.Buffer, names []string, separate SeparateFunc) {
	m.updateProgress(id, 5, "Loading the separation model")
	stems := make([][2][]float32, len(names))
	for i := range stems {
		stems[i] = [2][]float32{make([]float32, buf.Frames), make([]float32, buf.Frames)}
	}
	err := separate(ctx, buf.SampleRate, len(names), buf.Left, buf.Right, func(stem, start int, left, right []float32) error {
		if stem < 0 || stem >= len(stems) || start < 0 || len(left) != len(right) || start+len(left) > buf.Frames {
			return errors.New("separator wrote outside the stem buffers")
		}
		copy(stems[stem][0][start:], left)
		copy(stems[stem][1][start:], right)
		return nil
	}, func(fraction float64) {
		m.updateProgress(id, 5+int(85*min(1, max(0, fraction))), "Separating stems")
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			m.markCanceled(id)
			return
		}
		m.markFailed(id, err)
		return
	}
	m.updateProgress(id, 92, "Measuring stems")
	descriptors := make([]StemDescriptor, 0, len(names))
	pcm := make(map[string]stemAudio, len(names))
	for i, stemID := range names {
		metrics, err := dsp.MeasureStereoContext(ctx, stems[i][0], stems[i][1], float64(buf.SampleRate))
		if err != nil {
			if ctx.Err() != nil {
				m.markCanceled(id)
				return
			}
			m.markFailed(id, err)
			return
		}
		url := fmt.Sprintf("/jobs/%s/stems/%s", id, stemID)
		style := stemStyles[stemID]
		descriptors = append(descriptors, StemDescriptor{ID: stemID, Name: style.name, Role: stemID, Color: style.color, DownloadURL: url, URL: url, Metrics: metrics})
		pcm[stemID] = stemAudio{left: stems[i][0], right: stems[i][1], rate: buf.SampleRate}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Status == StatusCanceled {
		return
	}
	j.Stems, j.stemPCM = descriptors, pcm
	j.Progress, j.Stage, j.Status = 100, "Complete", StatusDone
	j.UpdatedAt = time.Now().UTC()
}
