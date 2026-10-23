package automation

import (
	"context"
	"testing"
)

func TestBoundSourceClockAdvancesWithoutScheduleAtExactFractionalPhase(t *testing.T) {
	for _, rates := range []struct{ source, device int }{{44100, 48000}, {48000, 44100}, {8001, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129, 48001} {
			clock, ok := NewSourceClock(rates.source, rates.device, frames)
			if !ok {
				t.Fatal("valid clock rejected")
			}
			clock.SetLooping(true)
			seek := frames / 3
			if err := clock.SeekSourceFrame(seek); err != nil {
				t.Fatal(err)
			}
			move := Move{ID: "gain", Target: "inputGainDb", Operation: "absolute", Points: []Point{{Frame: 0, Value: 0}, {Frame: frames, Value: 6}}}
			moves := []Move{move}
			if frames == 48001 {
				moves = append(moves, Move{ID: "eq", Target: "eq.0.gainDb", Operation: "absolute", Points: []Point{{Frame: 0, Value: 0}, {Frame: frames / 2, Value: 1}, {Frame: frames, Value: 0}}})
			}
			schedule, err := CompileContext(context.Background(), rates.source, rates.device, frames, 1, neutralValues(), moves)
			if err != nil {
				t.Fatal(err)
			}
			total := int64(0)
			for _, count := range []int{0, 1, 33, 127, 128, 129, 4096, 37} {
				clock.AdvanceFrames(count)
				total += int64(count)
				expected := (seek*int64(rates.device) + total*int64(rates.source)) % (frames * int64(rates.device))
				if clock.numerator != expected || clock.deviceFrame != expected/int64(rates.source) {
					t.Fatal("inactive clock lost rational phase", rates, frames, count)
				}
				cursor := NewCursor(schedule)
				if !cursor.CopyPosition(&clock) {
					t.Fatal("first schedule could not inherit bound clock")
				}
				var gain, width [1]float64
				_, values := cursor.Fill(gain[:], width[:], 1)
				cellFrame := expected / int64(rates.source) / int64(schedule.Quantum()) * int64(schedule.Quantum())
				heldTime := float64(cellFrame*int64(rates.source)) / float64(rates.device)
				if values[EQ0] != schedule.ValueAt(EQ0, heldTime) {
					t.Fatal("first schedule lost the absolute held-control lattice")
				}
				if gain[0] != schedule.ValueAt(InputGain, float64(expected)/float64(rates.device)) {
					t.Fatal("first schedule value reconstructed from rounded frame")
				}
			}
		}
	}
}

func TestBoundSourceClockInvalidLayoutSeekAndCopyAreAtomic(t *testing.T) {
	clock, ok := NewSourceClock(44100, 48000, 129)
	if !ok {
		t.Fatal("clock rejected")
	}
	clock.SetLooping(true)
	clock.AdvanceFrames(128)
	before := clock
	if _, ok := NewSourceClock(7999, 48000, 129); ok {
		t.Fatal("invalid source rate accepted")
	}
	if clock.SeekSourceFrame(130) == nil || clock != before {
		t.Fatal("invalid seek changed clock")
	}
	incompatible, _ := NewSourceClock(44100, 44100, 129)
	if clock.CopyPosition(&incompatible) || clock != before {
		t.Fatal("incompatible copy changed clock")
	}
	clock.AdvanceFrames(0)
	if clock != before {
		t.Fatal("no processed frames advanced clock")
	}
	var empty Cursor
	if empty.SeekSourceFrame(0) == nil || empty.CopyPosition(&clock) {
		t.Fatal("unbound clock accepted position")
	}
}
