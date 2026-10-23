package jobs

import (
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func TestScriptV2JobRetentionSnapshotAndCancellation(t *testing.T) {
	manager := NewManager(1)
	defer manager.Close()
	buf := &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: 8000, Duration: 1, Left: make([]float32, 8000), Right: make([]float32, 8000)}
	admitted, err := manager.SubmitAnalyzeDeepV2(buf, mastering.ProfileDynamicOpen)
	if err != nil {
		t.Fatal(err)
	}
	result := waitFeatures(t, manager, admitted.ID)
	if result.ScriptV2 == nil || result.Script != nil || result.Kind != KindAnalyzeDeepV2 {
		t.Fatal("wrong v2 result")
	}
	manager.mu.Lock()
	if manager.usedBytes != mastering.MaxScriptV2Bytes {
		t.Fatal("retained v2 script is uncharged")
	}
	manager.jobs[admitted.ID].ScriptV2.Moves = []automation.Move{{ID: "snapshot", Points: []automation.Point{{Frame: 0, Value: 1}, {Frame: 100, Value: 2}}}}
	manager.mu.Unlock()
	result, _ = manager.Get(admitted.ID)
	result.ScriptV2.Sections[0].Name = "mutated"
	result.ScriptV2.Moves[0].Points[0].Value = 123
	next, _ := manager.Get(admitted.ID)
	if next.ScriptV2.Sections[0].Name == "mutated" || next.ScriptV2.Moves[0].Points[0].Value == 123 {
		t.Fatal("consumer mutated retained script")
	}
	manager.Cancel(admitted.ID)
	manager.mu.RLock()
	used := manager.usedBytes
	manager.mu.RUnlock()
	if used != 0 {
		t.Fatal("retained script not released")
	}
	admitted, err = manager.SubmitAnalyzeDeepV2(buf, mastering.ProfileDynamicOpen)
	if err != nil {
		t.Fatal(err)
	}
	manager.Cancel(admitted.ID)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.RLock()
		used = manager.usedBytes
		manager.mu.RUnlock()
		if used == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if used != 0 {
		t.Fatal("active v2 reservation not released")
	}
}
