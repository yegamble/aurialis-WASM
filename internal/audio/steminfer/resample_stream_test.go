package steminfer

// cspell:words steminfer resampler

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestContinuousResamplingMatchesWholeBufferAtEveryPartition(t *testing.T) {
	for _, rates := range [][2]int{{44100, 44100}, {8001, 44100}, {44100, 8001}, {48000, 44100}, {44100, 192000}, {192000, 44100}} {
		plan, err := newResamplePlan(context.Background(), rates[0], rates[1])
		if err != nil {
			t.Fatal(err)
		}
		for _, length := range []int{1, 2, 127, 129, 4097} {
			source := [2][]float32{make([]float32, length), make([]float32, length)}
			for i := range length {
				source[0][i] = float32(.1 + .3*math.Sin(float64(i)*.23))
				source[1][i] = float32(.2 * math.Cos(float64(i)*.47))
			}
			source[0][0] = .7
			source[1][length-1] = -.4
			outputLength := (length*rates[1] + rates[0] - 1) / rates[0]
			want := [2][]float32{make([]float32, outputLength), make([]float32, outputLength)}
			for channel := range 2 {
				if err := plan.into(context.Background(), want[channel], source[channel], 0); err != nil {
					t.Fatal(err)
				}
			}
			for _, partition := range []int{1, 127, 129, 4096} {
				stream, err := newResampleStream(plan, length, outputLength)
				if err != nil {
					t.Fatal(err)
				}
				got := [2][]float32{}
				for first := 0; first < length; first += partition {
					end := min(first+partition, length)
					err := stream.push(context.Background(), first, source[0][first:end], source[1][first:end], func(start int, left, right []float32) error {
						if start != len(got[0]) || len(left) > outputBlockFrames {
							t.Fatal("noncontiguous or unbounded callback", start, len(got[0]), len(left))
						}
						got[0] = append(got[0], left...)
						got[1] = append(got[1], right...)
						return nil
					})
					if err != nil {
						t.Fatalf("rates%v length%d partition%d: %v", rates, length, partition, err)
					}
				}
				if stream.received != length || stream.next != outputLength {
					t.Fatal("stream duration changed")
				}
				for channel := range 2 {
					if len(got[channel]) != outputLength {
						t.Fatal("wrong exact output length")
					}
					for i, value := range got[channel] {
						if value != want[channel][i] {
							t.Fatalf("rates%v length%d partition%d channel%d sample%d got%g want%g", rates, length, partition, channel, i, value, want[channel][i])
						}
					}
				}
			}
		}
	}
}
func TestContinuousResamplingRejectsDiscontinuityAndCancellation(t *testing.T) {
	plan, err := newResamplePlan(context.Background(), 44100, 48000)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := newResampleStream(plan, 129, 140)
	if err != nil {
		t.Fatal(err)
	}
	consume := func(_ int, _, _ []float32) error { return nil }
	if err := stream.push(context.Background(), 1, []float32{1}, []float32{1}, consume); err == nil {
		t.Fatal("noncontiguous source accepted")
	}
	if stream.next != 0 || stream.received != 0 {
		t.Fatal("rejected span changed clock")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := stream.push(ctx, 0, []float32{1}, []float32{1}, consume); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if stream.next != 0 || stream.received != 0 {
		t.Fatal("pre-canceled source changed clock")
	}
	if _, err := newResampleStream(plan, 129, 1000); err == nil {
		t.Fatal("excess output duration accepted")
	}
}
