package main

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

type sourceEpochParityFixture struct {
	Rate                                 int                      `json:"rate"`
	SourceRate                           int                      `json:"sourceRate"`
	Frames                               int64                    `json:"frames"`
	Seek                                 int64                    `json:"seek"`
	Looping                              bool                     `json:"looping"`
	StaticFrames                         int                      `json:"staticFrames"`
	StageAt                              int                      `json:"stageAt"`
	DetachAt                             int                      `json:"detachAt"`
	ReapplyAt                            int                      `json:"reapplyAt"`
	Params                               dsp.Params               `json:"params"`
	Moves                                []automation.NumericMove `json:"moves"`
	Left, Right, OutputLeft, OutputRight []float32
}

func TestWriteSourceClockParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_SOURCE_CLOCK_FIXTURE")
	if path == "" {
		t.Skip("set source-clock parity artifact path")
	}
	fixtures := []sourceEpochParityFixture{}
	for _, rates := range []struct{ source, device int }{{44100, 48000}, {48000, 44100}, {8001, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129, 48001} {
			source := sourceBinding{rate: rates.source, frames: frames}
			params := staticEpochParams()
			schedule := epochSchedule(t, source, rates.device, params)
			const count = 4096
			left, right := epochInputs(0, count)
			staticFrames := 128
			if frames == 129 {
				staticFrames = 384
			}
			item := sourceEpochParityFixture{Rate: rates.device, SourceRate: rates.source, Frames: frames, Seek: frames / 3, Looping: true, StaticFrames: staticFrames, StageAt: 128, DetachAt: 1024, ReapplyAt: 1536, Params: params, Moves: schedule.NumericMoves(), Left: left, Right: right, OutputLeft: make([]float32, count), OutputRight: make([]float32, count)}
			// The independent oracle uses direct rational arithmetic, not a bridge/cursor.
			engine := dsp.NewEngine(float64(rates.device))
			engine.SetParams(params)
			engine.Reset()
			var gain [128]float64
			for start := 0; start < count; start += 128 {
				automated := start >= staticFrames && (start < item.DetachAt || start >= item.ReapplyAt)
				end := start + 128
				if automated {
					for i := range gain {
						phase := (item.Seek*int64(rates.device) + int64(start+i)*int64(rates.source)) % (frames * int64(rates.device))
						gain[i] = schedule.ValueAt(automation.InputGain, float64(phase)/float64(rates.device))
					}
					if !engine.ProcessAutomationBlock(left[start:end], right[start:end], item.OutputLeft[start:end], item.OutputRight[start:end], gain[:], nil) {
						t.Fatal("oracle rejected")
					}
				} else {
					engine.ProcessBlock(left[start:end], right[start:end], item.OutputLeft[start:end], item.OutputRight[start:end])
				}
			}
			fixtures = append(fixtures, item)
		}
	}
	data, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- Test-only artifact path supplied by the local parity harness, never an upload or HTTP path.
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
