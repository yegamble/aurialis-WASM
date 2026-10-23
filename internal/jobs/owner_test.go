package jobs

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func TestOwnerScopesEveryAdmissionAndKeepsIdentityPrivate(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	owner, foreign := manager.ForOwner("owner-a"), manager.ForOwner("owner-b")
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 64, Left: make([]float32, 64), Right: make([]float32, 64)}
	for _, submit := range []struct {
		name string
		run  func() (*Job, error)
	}{
		{"stems", func() (*Job, error) { return owner.SubmitSeparate(buf, 2) }},
		{"deep", func() (*Job, error) { return owner.SubmitAnalyzeDeep(buf, mastering.ProfileID("modern_pop_polish")) }},
		{"automation", func() (*Job, error) { return owner.SubmitAnalyzeDeepV2(buf, mastering.ProfileID("modern_pop_polish")) }},
		{"features", func() (*Job, error) { return owner.SubmitAnalyzeFeatures(buf) }},
		{"reference", func() (*Job, error) {
			return owner.SubmitAnalyzeReference(buf, buf, dsp.DefaultParams(), mastering.ReferenceOptions{Amount: .5, ProtectBelowHz: 120})
		}},
	} {
		t.Run(submit.name, func(t *testing.T) {
			job, err := submit.run()
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := owner.Get(job.ID); !ok {
				t.Fatal("owner cannot read admitted job")
			}
			if _, ok := foreign.Get(job.ID); ok {
				t.Fatal("foreign owner read admitted job")
			}
			if _, ok := manager.Get(job.ID); ok {
				t.Fatal("local namespace read hosted job")
			}
			if _, ok := foreign.Cancel(job.ID); ok {
				t.Fatal("foreign owner canceled admitted job")
			}
			if _, ok := manager.Cancel(job.ID); ok {
				t.Fatal("local namespace canceled hosted job")
			}
			encoded, err := json.Marshal(job)
			if err != nil || strings.Contains(string(encoded), "owner-a") || strings.Contains(string(encoded), "owner") {
				t.Fatalf("owner leaked into JSON or invalid snapshot: %v", err)
			}
			if _, ok := owner.Cancel(job.ID); !ok {
				t.Fatal("owner cannot cancel admitted job")
			}
		})
	}
	local, err := manager.SubmitAnalyzeFeatures(buf)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := owner.Get(local.ID); ok {
		t.Fatal("hosted owner read local namespace")
	}
	if _, ok := manager.Cancel(local.ID); !ok {
		t.Fatal("local compatibility wrapper cannot cancel local job")
	}
}

func TestOwnerScopesActualCompletedStemDownload(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	owner, foreign := manager.ForOwner("owner-a"), manager.ForOwner("owner-b")
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 64, Left: make([]float32, 64), Right: make([]float32, 64)}
	buf.Left[10], buf.Right[10] = .5, -.25
	job, err := owner.SubmitSeparate(buf, 2)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		job, _ = owner.Get(job.ID)
		if job.Status == StatusDone {
			break
		}
		if job.Status == StatusFailed || time.Now().After(deadline) {
			t.Fatalf("separation did not finish: %+v", job)
		}
		time.Sleep(time.Millisecond)
	}
	if len(job.Stems) != 2 {
		t.Fatal("missing reconstructed stems")
	}
	name := job.Stems[0].ID
	if wav, ok := owner.StemWAV(job.ID, name); !ok || len(wav) <= 44 || string(wav[:4]) != "RIFF" {
		t.Fatal("owner cannot download actual reconstructed stem")
	}
	if _, ok := foreign.StemWAV(job.ID, name); ok {
		t.Fatal("foreign owner downloaded stem")
	}
	if _, ok := manager.StemWAV(job.ID, name); ok {
		t.Fatal("local namespace downloaded hosted stem")
	}
	if _, ok := foreign.Cancel(job.ID); ok {
		t.Fatal("foreign owner deleted completed artifacts")
	}
	if _, ok := owner.StemWAV(job.ID, name); !ok {
		t.Fatal("foreign cancellation changed artifact")
	}
}
