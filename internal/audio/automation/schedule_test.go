package automation

import (
	"context"
	"errors"
	"math"
	"testing"
)

func neutralValues() Values {
	values := Values{}
	values[CompressorRatio] = 1
	values[Width] = 100
	return values
}
func authored(target string, value float64) Move {
	return Move{ID: "move-1", SectionID: "section-1", Target: target, Operation: "absolute", Points: []Point{{Frame: 800, Value: value}, {Frame: 7200, Value: value}}, FadeFrames: 400}
}
func compile(t *testing.T, moves []Move) *Schedule {
	t.Helper()
	schedule, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), moves)
	if err != nil {
		t.Fatal(err)
	}
	return schedule
}

func TestSourceFrameEnvelopeHalfOpenFadesAndBaselineAdd(t *testing.T) {
	move := authored("inputGainDb", 6)
	move.Operation = "add"
	baseline := neutralValues()
	baseline[InputGain] = 2
	schedule, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, baseline, []Move{move})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ frame, value float64 }{{799, 2}, {800, 2}, {1000, 5}, {1200, 8}, {4000, 8}, {7000, 5}, {7200, 2}} {
		if got := schedule.ValueAt(InputGain, test.frame); math.Abs(got-test.value) > 1e-12 {
			t.Fatalf("frame%g got%g want%g", test.frame, got, test.value)
		}
	}
	move.Muted = true
	schedule = compile(t, []Move{move})
	if schedule.Used(InputGain) || schedule.ValueAt(InputGain, 4000) != 0 {
		t.Fatal("muted move changed baseline")
	}
}

func TestDenseCurveCoalescingErrorBudgetAndAtomicCompilation(t *testing.T) {
	move := authored("eq.0.gainDb", 0.8)
	for i := 0; i < 256; i++ {
		move.Points = append(move.Points[:min(i, len(move.Points))], Point{Frame: 800 + int64(i)*20, Value: 0.8})
	}
	schedule := compile(t, []Move{move})
	if schedule.moves[0].count != 2 {
		t.Fatal("collinear authored density was retained")
	}
	rapid := authored("eq.0.gainDb", 3)
	rapid.FadeFrames = 1
	if _, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), []Move{rapid}); err == nil {
		t.Fatal("rapid expensive envelope accepted")
	}
	discontinuity := authored("compressor.thresholdDb", -1)
	discontinuity.FadeFrames = 0
	if _, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), []Move{discontinuity}); err == nil {
		t.Fatal("non-neutral zero-fade coefficient jump accepted")
	}
	if schedule.ValueAt(EQ0, 4000) != 0.8 {
		t.Fatal("rejected compilation changed accepted schedule")
	}
}

func TestClosedTargetsOverlapBoundsAndCancellation(t *testing.T) {
	for _, target := range []string{"repair.deEssDb", "repair.transientDb", "constructor.prototype", "eq.5.gainDb"} {
		move := authored(target, 1)
		if _, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), []Move{move}); err == nil {
			t.Fatal("unsupported target accepted", target)
		}
	}
	first, second := authored("inputGainDb", 1), authored("inputGainDb", 2)
	second.ID = "move-2"
	if _, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), []Move{first, second}); err == nil {
		t.Fatal("overlapping target intervals accepted")
	}
	for _, invalid := range []Move{
		{ID: "bad", Target: "inputGainDb", Operation: "multiply", Points: []Point{{0, 1}, {100, 1}}},
		{ID: "bad", Target: "inputGainDb", Operation: "absolute", Points: []Point{{100, 1}, {100, 2}}},
		{ID: "bad", Target: "inputGainDb", Operation: "absolute", Points: []Point{{0, math.Inf(1)}, {100, 1}}},
	} {
		if _, err := CompileContext(context.Background(), 8000, 8000, 8000, 1, neutralValues(), []Move{invalid}); err == nil {
			t.Fatal("malformed move accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := CompileContext(ctx, 8000, 8000, 8000, 1, neutralValues(), []Move{first}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled setup accepted", err)
	}
}

func TestRationalClockPartitionInvarianceSeekAndPerSampleGainWidth(t *testing.T) {
	gain := authored("inputGainDb", 6)
	gain.Points = []Point{{Frame: 0, Value: 0}, {Frame: 8000, Value: 6}}
	gain.FadeFrames = 0
	width := gain
	width.ID = "width"
	width.Target = "stereo.widthPct"
	width.Points = []Point{{Frame: 0, Value: 100}, {Frame: 8000, Value: 180}}
	for _, rate := range []int{8000, 44100, 48000, 192000} {
		schedule, err := CompileContext(context.Background(), 8000, rate, 8000, 1, neutralValues(), []Move{gain, width})
		if err != nil {
			t.Fatal(err)
		}
		var reference [1000][2]float64
		for pass, partition := range []int{1, 127, 128, 129, 4096} {
			cursor := NewCursor(schedule)
			var gains, widths [4096]float64
			for processed := 0; processed < 1000; {
				count, _ := cursor.Fill(gains[:], widths[:], min(partition, 1000-processed))
				if count < 1 || count > max(1, rate/1000) {
					t.Fatal("coefficient quantum not bounded")
				}
				for i := 0; i < count; i++ {
					pair := [2]float64{gains[i], widths[i]}
					if pass == 0 {
						reference[processed+i] = pair
					} else if pair != reference[processed+i] {
						t.Fatal("block partition changed authored time")
					}
				}
				processed += count
			}
			if err := cursor.SeekSourceFrame(4000); err != nil {
				t.Fatal(err)
			}
			cursor.Fill(gains[:], widths[:], 1)
			if math.Abs(gains[0]-3) > 1e-12 || math.Abs(widths[0]-140) > 1e-12 {
				t.Fatal("source seek lost rational clock")
			}
			before := *cursor
			if err := cursor.SeekSourceFrame(-1); err == nil || *cursor != before {
				t.Fatal("invalid seek changed clock")
			}
		}
	}
}

func TestCursorProcessingAllocatesNothing(t *testing.T) {
	schedule := compile(t, []Move{authored("inputGainDb", 3), authoredWidth()})
	cursor := NewCursor(schedule)
	var gain, width [128]float64
	if allocations := testing.AllocsPerRun(100, func() { cursor.Fill(gain[:], width[:], 128) }); allocations != 0 {
		t.Fatalf("processing allocated%g", allocations)
	}
}
func authoredWidth() Move { move := authored("stereo.widthPct", 120); move.ID = "width"; return move }

func TestSeekUsesAbsoluteSourceZeroCoefficientLattice(t *testing.T) {
	move := authored("eq.0.gainDb", .8)
	move.Points = []Point{{Frame: 0, Value: 0}, {Frame: 4000, Value: .8}, {Frame: 8000, Value: 0}}
	move.FadeFrames = 0
	for _, rate := range []int{8000, 8001, 44100, 48000, 192000} {
		schedule, err := CompileContext(context.Background(), 8000, rate, 8000, 1, neutralValues(), []Move{move})
		if err != nil {
			t.Fatal(err)
		}
		for _, sourceFrame := range []int64{1, 123, 4001, 7999} {
			cursor := NewCursor(schedule)
			if err := cursor.SeekSourceFrame(sourceFrame); err != nil {
				t.Fatal(err)
			}
			var gain, width [128]float64
			for offset := int64(0); offset < 200; {
				count, values := cursor.Fill(gain[:], width[:], int(200-offset))
				if count < 1 {
					t.Fatal("empty span")
				}
				absoluteDevice := sourceFrame*int64(rate)/8000 + offset
				cellStart := absoluteDevice / int64(schedule.Quantum()) * int64(schedule.Quantum())
				expected := schedule.ValueAt(EQ0, float64(cellStart*8000)/float64(rate))
				if values[EQ0] != expected {
					t.Fatalf("seek re-anchored source-zero lattice rate %d source %d offset %d", rate, sourceFrame, offset)
				}
				for i := range count {
					exactSource := float64(sourceFrame) + float64(offset+int64(i))*8000/float64(rate)
					if math.Abs(schedule.ValueAt(EQ0, exactSource)-values[EQ0]) > .1+1e-12 {
						t.Fatal("seek phase exceeds held control tolerance")
					}
				}
				offset += int64(count)
			}
		}
	}
}

func TestInterpolationPreservesExactKnotsAndAuthoritativeBounds(t *testing.T) {
	baseline := neutralValues()
	move := Move{ID: "ratio", Target: "compressor.ratio", Operation: "absolute", Points: []Point{{Frame: 0, Value: 1}, {Frame: 96000, Value: 100}, {Frame: 192000, Value: 1}, {Frame: 288000, Value: 1}}}
	schedule, err := CompileContext(context.Background(), 8000, 8000, 288000, 1, baseline, []Move{move})
	if err != nil {
		t.Fatal(err)
	}
	if schedule.ValueAt(CompressorRatio, 192000) != 1 {
		t.Fatal("exact authored endpoint lost precision")
	}
	for i := 0; i < 200; i++ {
		frame := 192000 + float64(i-100)*.00001
		value := schedule.ValueAt(CompressorRatio, frame)
		if value < 1 || value > 100 {
			t.Fatal("convex interpolation left valid endpoint range", frame, value)
		}
	}
}

func TestLoopingRationalPhaseMidBlockAndManyWraps(t *testing.T) {
	for _, pair := range []struct{ source, device int }{{8001, 44100}, {48000, 44100}, {48000, 192000}} {
		for _, frames := range []int64{1, 127, 129, 8001} {
			move := Move{ID: "gain", Target: "inputGainDb", Operation: "absolute", Points: []Point{{Frame: 0, Value: 0}, {Frame: frames, Value: 6}}}
			heavy := Move{ID: "eq", Target: "eq.0.gainDb", Operation: "absolute", Points: []Point{{Frame: 0, Value: 0}, {Frame: frames, Value: 0}}}
			if frames > 2 {
				heavy.Points = []Point{{Frame: 0, Value: 0}, {Frame: frames / 2, Value: .0001}, {Frame: frames, Value: 0}}
			}
			schedule, err := CompileContext(context.Background(), pair.source, pair.device, frames, 1, neutralValues(), []Move{move, heavy})
			if err != nil {
				t.Fatal(err)
			}
			for _, partition := range []int{1, 127, 128, 129, 4096} {
				cursor := NewCursor(schedule)
				cursor.SetLooping(true)
				var gain, width [4096]float64
				const outputFrames = 16384
				for start := 0; start < outputFrames; {
					count, held := cursor.Fill(gain[:], width[:], min(partition, outputFrames-start))
					if count < 1 {
						t.Fatal("loop made no progress")
					}
					for i := range count {
						numerator := int64(start+i) * int64(pair.source) % (frames * int64(pair.device))
						expected := schedule.ValueAt(InputGain, float64(numerator)/float64(pair.device))
						devicePosition := numerator / int64(pair.source)
						cellStart := devicePosition / int64(schedule.Quantum()) * int64(schedule.Quantum())
						expectedHeavy := schedule.ValueAt(EQ0, float64(cellStart*int64(pair.source))/float64(pair.device))
						if held[EQ0] != expectedHeavy {
							t.Fatal("loop re-anchored held source-zero lattice incorrectly")
						}
						if gain[i] != expected {
							t.Fatalf("loop phase mismatch %v source length %d partition%d output%d got%g want%g", pair, frames, partition, start+i, gain[i], expected)
						}
					}
					start += count
				}
			}
		}
	}
}
