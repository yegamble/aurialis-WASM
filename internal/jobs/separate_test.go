package jobs_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
)

// splitEvenly stands in for the trained model: every stem gets an equal share
// of the mix, written in two chunks to exercise ordered sink calls.
func splitEvenly(ctx context.Context, _, stems int, left, right []float32, sink func(int, int, []float32, []float32) error, progress func(float64)) error {
	for stem := range stems {
		half := len(left) / 2
		for _, span := range [][2]int{{0, half}, {half, len(left)}} {
			l, r := make([]float32, span[1]-span[0]), make([]float32, span[1]-span[0])
			for i := range l {
				l[i] = left[span[0]+i] / float32(stems)
				r[i] = right[span[0]+i] / float32(stems)
			}
			if err := sink(stem, span[0], l, r); err != nil {
				return err
			}
		}
		progress(float64(stem+1) / float64(stems))
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return nil
}

func waitFor(t *testing.T, mgr *jobs.Manager, id string, done func(*jobs.Job) bool) *jobs.Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if job, ok := mgr.Get(id); ok && done(job) {
			return job
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return nil
}

func TestSeparationDeliversNamedStemsThatSumToTheMix(t *testing.T) {
	mgr := jobs.NewManager(1)
	defer mgr.Close()
	mgr.SetSeparator(splitEvenly)
	buf := makeTestBuffer()
	for stems, names := range map[int][]string{2: {"vocals", "instrumental"}, 4: {"vocals", "drums", "bass", "other"}, 6: {"vocals", "drums", "bass", "guitar", "piano", "other"}} {
		job, err := mgr.SubmitSeparate(buf, stems)
		if err != nil {
			t.Fatal(err)
		}
		done := waitFor(t, mgr, job.ID, func(j *jobs.Job) bool { return j.Status == jobs.StatusDone || j.Status == jobs.StatusFailed })
		if done.Status != jobs.StatusDone || len(done.Stems) != stems {
			t.Fatalf("%d stems: status %s, %d stems, error %q", stems, done.Status, len(done.Stems), done.Error)
		}
		sum := make([]float64, buf.Frames)
		for i, stem := range done.Stems {
			if stem.ID != names[i] || stem.Name == "" || stem.DownloadURL != "/jobs/"+job.ID+"/stems/"+names[i] {
				t.Fatalf("stem %d: %+v", i, stem)
			}
			wav, ok := mgr.StemWAV(job.ID, stem.ID)
			if !ok {
				t.Fatal("missing WAV", stem.ID)
			}
			decoded, err := audio.DecodeAndDisarm("stem.wav", wav)
			if err != nil || decoded.Frames != buf.Frames || decoded.SampleRate != buf.SampleRate {
				t.Fatalf("stem %s decode: %v", stem.ID, err)
			}
			if bits := wav[34]; bits != 24 {
				t.Fatalf("stem %s is %d-bit", stem.ID, bits)
			}
			for i, v := range decoded.Left {
				sum[i] += float64(v)
			}
		}
		for i, v := range sum {
			if d := v - float64(buf.Left[i]); d > 1e-5 || d < -1e-5 {
				t.Fatalf("%d stems do not sum to the mix at %d: %g", stems, i, d)
			}
		}
	}
}

func TestSeparationFailureAndCancellationKeepNoStems(t *testing.T) {
	mgr := jobs.NewManager(1)
	defer mgr.Close()
	mgr.SetSeparator(func(context.Context, int, int, []float32, []float32, func(int, int, []float32, []float32) error, func(float64)) error {
		return errors.New("model checksum mismatch")
	})
	job, err := mgr.SubmitSeparate(makeTestBuffer(), 4)
	if err != nil {
		t.Fatal(err)
	}
	failed := waitFor(t, mgr, job.ID, func(j *jobs.Job) bool { return j.Status == jobs.StatusFailed })
	if failed.Error != "model checksum mismatch" || len(failed.Stems) != 0 {
		t.Fatalf("%+v", failed)
	}
	started := make(chan struct{})
	mgr.SetSeparator(func(ctx context.Context, _, _ int, _, _ []float32, _ func(int, int, []float32, []float32) error, _ func(float64)) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	job, err = mgr.SubmitSeparate(makeTestBuffer(), 4)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	mgr.Cancel(job.ID)
	canceled := waitFor(t, mgr, job.ID, func(j *jobs.Job) bool { return j.Status == jobs.StatusCanceled })
	if _, ok := mgr.StemWAV(job.ID, "vocals"); ok || len(canceled.Stems) != 0 {
		t.Fatal("canceled separation kept stems")
	}
}
