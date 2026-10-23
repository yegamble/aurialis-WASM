// cspell:words automator

package automator

import (
	"context"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func compiled(t *testing.T, params dsp.Params, moves []automation.Move, rate int) *automation.Schedule {
	t.Helper()
	schedule, err := automation.CompileContext(context.Background(), 48000, rate, 48000, 1, ValuesOf(params), moves)
	if err != nil {
		t.Fatal(err)
	}
	return schedule
}
func testMoves() []automation.Move {
	return []automation.Move{
		{ID: "gain", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: 48000, Value: 3}}},
		{ID: "width", Target: "stereo.widthPct", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 100}, {Frame: 48000, Value: 160}}},
		{ID: "eq", Target: "eq.2.gainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: 24000, Value: 0.8}, {Frame: 48000, Value: 0}}},
	}
}
func TestPartitionsAndEmptySchedulePreservePCM(t *testing.T) {
	params := dsp.DefaultParams()
	params.Limiter.Enabled = false
	const count = 8192
	left, right := make([]float32, count), make([]float32, count)
	for i := range left {
		left[i] = float32(.2 * math.Sin(float64(i)*.13))
		right[i] = float32(.1 * math.Cos(float64(i)*.17))
	}
	for _, rate := range []int{8000, 44100, 48000, 192000} {
		for _, moves := range [][]automation.Move{nil, testMoves()} {
			schedule := compiled(t, params, moves, rate)
			var referenceL, referenceR []float32
			for _, partition := range []int{1, 127, 128, 129, 4096} {
				engine := dsp.NewEngine(float64(rate))
				processor, err := New(engine, params, schedule)
				if err != nil {
					t.Fatal(err)
				}
				outL, outR := make([]float32, count), make([]float32, count)
				for start := 0; start < count; start += partition {
					end := min(count, start+partition)
					processor.ProcessBlock(left[start:end], right[start:end], outL[start:end], outR[start:end])
				}
				if referenceL == nil {
					referenceL, referenceR = outL, outR
				} else {
					for i := range outL {
						if outL[i] != referenceL[i] || outR[i] != referenceR[i] {
							t.Fatalf("partition changed PCM rate %d partition %d frame %d", rate, partition, i)
						}
					}
				}
			}
			if moves == nil {
				engine := dsp.NewEngine(float64(rate))
				engine.SetParams(params)
				outL, outR := make([]float32, count), make([]float32, count)
				engine.ProcessBlock(left, right, outL, outR)
				for i := range outL {
					if outL[i] != referenceL[i] || outR[i] != referenceR[i] {
						t.Fatal("empty schedule changed legacy PCM")
					}
				}
			}
		}
	}
}
func TestInvalidInstallSeekAndProcessingAllocations(t *testing.T) {
	params := dsp.DefaultParams()
	schedule := compiled(t, params, testMoves(), 48000)
	engine := dsp.NewEngine(48000)
	processor, err := New(engine, params, schedule)
	if err != nil {
		t.Fatal(err)
	}
	wrong := params
	wrong.InputGainDB = 1
	if _, err := New(engine, wrong, schedule); err == nil || engine.Params() != params {
		t.Fatal("invalid installation changed baseline")
	}
	var left, right, outL, outR [128]float32
	if allocations := testing.AllocsPerRun(100, func() { processor.ProcessBlock(left[:], right[:], outL[:], outR[:]) }); allocations != 0 {
		t.Fatalf("processing allocated %g", allocations)
	}
	if err := processor.SeekSourceFrame(2000); err != nil {
		t.Fatal(err)
	}
	if err := processor.SeekSourceFrame(-1); err == nil {
		t.Fatal("invalid seek accepted")
	}
	processor.ProcessBlock(left[:], right[:], outL[:], outR[:])
}
func BenchmarkDenseAutomation128(b *testing.B) {
	params := dsp.DefaultParams()
	moves := testMoves()
	schedule, err := automation.CompileContext(context.Background(), 48000, 48000, 48000, 1, ValuesOf(params), moves)
	if err != nil {
		b.Fatal(err)
	}
	processor, err := New(dsp.NewEngine(48000), params, schedule)
	if err != nil {
		b.Fatal(err)
	}
	var left, right, outL, outR [128]float32
	for i := range left {
		left[i] = .2
		right[i] = .1
	}
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := range b.N {
		if iteration%300 == 0 {
			if err := processor.SeekSourceFrame(1000); err != nil {
				b.Fatal(err)
			}
		}
		processor.ProcessBlock(left[:], right[:], outL[:], outR[:])
	}
}

func TestMutedRevisionRetainsExactFractionalPosition(t *testing.T) {
	params := dsp.DefaultParams()
	for _, rate := range []int{8000, 44100, 48000, 192000} {
		inactive, err := New(dsp.NewEngine(float64(rate)), params, compiled(t, params, nil, rate))
		if err != nil {
			t.Fatal(err)
		}
		if err := inactive.SeekSourceFrame(123); err != nil {
			t.Fatal(err)
		}
		var inL, inR, outL, outR [129]float32
		inactive.ProcessBlock(inL[:], inR[:], outL[:], outR[:])
		active, err := New(dsp.NewEngine(float64(rate)), params, compiled(t, params, testMoves(), rate))
		if err != nil {
			t.Fatal(err)
		}
		if !active.InheritPosition(inactive) {
			t.Fatal("compatible revision lost source clock")
		}
		var gain, width [1]float64
		active.cursor.Fill(gain[:], width[:], 1)
		expectedSource := 123 + 129*48000/float64(rate)
		expected := active.schedule.ValueAt(automation.InputGain, expectedSource)
		if math.Abs(gain[0]-expected) > 1e-12 {
			t.Fatalf("muted revision reset clock rate %d got %g expected %g", rate, gain[0], expected)
		}
	}
}

func TestClosedCompiledRangesNeverRejectDSPSafeguards(t *testing.T) {
	params := dsp.DefaultParams()
	values := ValuesOf(params)
	metadata := automation.Targets()
	moves := make([]automation.Move, automation.TargetCount)
	for target, field := range metadata {
		moves[target] = automation.Move{ID: field.Name, Target: field.Name, Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: values[target]}, {Frame: 96000, Value: field.Maximum}, {Frame: 192000, Value: field.Minimum}, {Frame: 288000, Value: values[target]}}}
	}
	for _, rate := range []int{8000, 8001, 44100, 48000, 192000} {
		schedule, err := automation.CompileContext(context.Background(), 8000, rate, 288000, 1, values, moves)
		if err != nil {
			t.Fatal(err)
		}
		processor, err := New(dsp.NewEngine(float64(rate)), params, schedule)
		if err != nil {
			t.Fatal(err)
		}
		var left, right, outL, outR [128]float32
		for _, frame := range []int64{0, 1, 95999, 96000, 96001, 191999, 192000, 192001, 287999} {
			if err := processor.SeekSourceFrame(frame); err != nil {
				t.Fatal(err)
			}
			if !processor.ProcessBlock(left[:], right[:], outL[:], outR[:]) {
				t.Fatalf("valid compiled ranges failed safeguard rate %d frame %d", rate, frame)
			}
		}
	}
}

func TestLoopSeamsPreserveDSPHistoryAndMatchIndependentGainOracle(t *testing.T) {
	params := dsp.DefaultParams()
	params.Bands[2].GainDB = 3
	for _, pair := range []struct{ source, device int }{{8001, 44100}, {48000, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129} {
			move := automation.Move{ID: "loop", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: frames, Value: 3}}}
			schedule, err := automation.CompileContext(context.Background(), pair.source, pair.device, frames, 1, ValuesOf(params), []automation.Move{move})
			if err != nil {
				t.Fatal(err)
			}
			processor, err := New(dsp.NewEngine(float64(pair.device)), params, schedule)
			if err != nil {
				t.Fatal(err)
			}
			processor.SetLooping(true)
			reference := dsp.NewEngine(float64(pair.device))
			reference.SetParams(params)
			var left, right, actualL, actualR, expectedL, expectedR [128]float32
			var gain [128]float64
			for block := 0; block < 32; block++ {
				for i := range left {
					left[i] = .2
					right[i] = -.1
					numerator := int64(block*128+i) * int64(pair.source) % (frames * int64(pair.device))
					gain[i] = schedule.ValueAt(automation.InputGain, float64(numerator)/float64(pair.device))
				}
				if !processor.ProcessBlock(left[:], right[:], actualL[:], actualR[:]) || !reference.ProcessAutomationBlock(left[:], right[:], expectedL[:], expectedR[:], gain[:], nil) {
					t.Fatal("loop processing rejected")
				}
				if actualL != expectedL || actualR != expectedR {
					t.Fatal("loop seam reset DSP history or lost exact source phase")
				}
			}
		}
	}
}
