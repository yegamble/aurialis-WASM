package automation

import (
	"context"
	"fmt"
	"math"
	"testing"
)

func densePreparedPoints(start int64) []Point {
	points := make([]Point, 256)
	for i := range points {
		value := .0001 * math.Sin(float64(i))
		if i == 0 || i == 255 {
			value = 0
		}
		points[i] = Point{Frame: start + int64(i)*16, Value: value}
	}
	return points
}
func TestPreparedSlotsRejectAtomicallyAndPublishNoAllocations(t *testing.T) {
	builder := new(Builder)
	baseline := neutralValues()
	points := densePreparedPoints(0)
	if !builder.Begin(48000, 48000, 128*4096, 1, baseline, 128) {
		t.Fatal("begin rejected")
	}
	for i := 127; i >= 0; i-- {
		points = densePreparedPoints(int64(i) * 4096)
		if !builder.Stage(127-i, EQ0, 0, false, points) {
			t.Fatal("bounded dense stage rejected")
		}
	}
	var schedule *Schedule
	if allocations := testing.AllocsPerRun(1, func() {
		builder.ready = true
		var ok bool
		schedule, ok = builder.Finalize()
		if !ok {
			t.Fatal("publish rejected")
		}
	}); allocations != 0 {
		t.Fatal("finalization allocated", allocations)
	}
	if schedule == nil || !schedule.Used(EQ0) || builder.Stage(0, EQ0, 0, false, points) {
		t.Fatal("sealed slot remained writable")
	}
	var next Builder
	if !next.Begin(48000, 48000, 8000, 2, baseline, 1) {
		t.Fatal("next begin failed")
	}
	points = []Point{{Frame: 0, Value: 0}, {Frame: 4000, Value: .1}, {Frame: 8000, Value: 0}}
	if allocations := testing.AllocsPerRun(100, func() {
		if !next.Stage(0, EQ0, 0, false, points) {
			t.Fatal("stage failed")
		}
	}); allocations != 0 {
		t.Fatal("valid staging allocated", allocations)
	}
	invalid := append([]Point{}, points...)
	invalid[1].Value = math.NaN()
	if next.Stage(0, EQ0, 0, false, invalid) {
		t.Fatal("invalid stage accepted")
	}
	accepted, ok := next.Finalize()
	if !ok || accepted.ValueAt(EQ0, 4000) != .1 {
		t.Fatal("invalid stage changed inactive accepted move")
	}
}
func BenchmarkStageDense256Points(b *testing.B) {
	var builder Builder
	builder.Begin(48000, 48000, 8000, 1, neutralValues(), 1)
	points := densePreparedPoints(0)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if !builder.Stage(0, EQ0, 0, false, points) {
			b.Fatal("invalid")
		}
	}
}
func BenchmarkFinalize128Moves(b *testing.B) {
	var builder Builder
	baseline := neutralValues()
	points := []Point{{Frame: 0, Value: 0}, {Frame: 100, Value: 0}}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		b.StopTimer()
		builder.Begin(48000, 48000, 128*4096, 1, baseline, 128)
		for i := 127; i >= 0; i-- {
			points[0].Frame = int64(i) * 4096
			points[1].Frame = points[0].Frame + 100
			builder.Stage(127-i, EQ0, 0, false, points)
		}
		b.StartTimer()
		if _, ok := builder.Finalize(); !ok {
			b.Fatal("invalid")
		}
	}
}

func BenchmarkCompileMaximumCapacity(b *testing.B) {
	moves := make([]Move, 128)
	for i := range moves {
		moves[i] = Move{ID: fmt.Sprintf("move-%d", i), Target: "eq.0.gainDb", Operation: "absolute", Points: densePreparedPoints(int64(127-i) * 4096)}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := CompileContext(context.Background(), 48000, 192000, 128*4096, 1, neutralValues(), moves); err != nil {
			b.Fatal(err)
		}
	}
}
