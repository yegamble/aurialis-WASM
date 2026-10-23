package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestChunkAssemblyIdentityAllLengthsAndSeams(t *testing.T) {
	for _, length := range []int{1, 2, 127, 129, 499, 500, 501, 999, 1000, 1001, 2001, 3007} {
		work, err := newChunkAssembler(length, 1000, 5)
		if err != nil {
			t.Fatal(err)
		}
		source := [2][]float32{make([]float32, length), make([]float32, length)}
		for i := range length {
			source[0][i] = float32(math.Sin(float64(i) * .19))
			source[1][i] = float32(i%31-15) / 16
		}
		received := [5]int{}
		for work.position < work.total {
			left, right, err := work.input(context.Background(), func(channel, index int) float32 { return source[channel][index] })
			if err != nil {
				t.Fatal(err)
			}
			for head := range 5 {
				if err := work.accept(context.Background(), head, left, right); err != nil {
					t.Fatal(err)
				}
			}
			err = work.advance(context.Background(), func(head, start int, left, right []float32) error {
				if start != received[head] {
					t.Fatalf("noncontiguous length%d head%d start%d want%d", length, head, start, received[head])
				}
				for channel, got := range [2][]float32{left, right} {
					for i, value := range got {
						if math.Abs(float64(value-source[channel][start+i])) > 2e-7 {
							t.Fatalf("seam changed identity length%d head%d source%d", length, head, start+i)
						}
					}
				}
				received[head] += len(left)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		}
		for head, count := range received {
			if count != length {
				t.Fatalf("length%d head%d received%d", length, head, count)
			}
		}
	}
}
func TestChunkInputUsesOriginalBorderReflectAndShortTailConventions(t *testing.T) {
	for _, length := range []int{1, 500, 501, 502, 1000, 1001, 2001} {
		work, err := newChunkAssembler(length, 1000, 1)
		if err != nil {
			t.Fatal(err)
		}
		left, _, err := work.input(context.Background(), func(_, index int) float32 { return float32(index + 1) })
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case length > 1000:
			if left[0] != 501 || left[500] != 1 || left[999] != 500 {
				t.Fatal("left reflected border differs from original convention", length, left[0], left[500], left[999])
			}
		case length <= 501:
			for _, value := range left[length:] {
				if value != 0 {
					t.Fatal("short model tail was not zero padded", length)
				}
			}
		case length < 1000:
			if left[length] != float32(length-1) || left[999] != float32(2*(length-1)-999+1) {
				t.Fatal("long model tail reflection mismatch", length)
			}
		}
	}
}
func TestChunkContextDependentOutputsMatchIndependentWeightedTimeline(t *testing.T) {
	const length, chunk = 2507, 1000
	work, err := newChunkAssembler(length, chunk, 1)
	if err != nil {
		t.Fatal(err)
	}
	chunks := 0
	for work.position < work.total {
		left, right, err := work.input(context.Background(), func(_, index int) float32 { return float32(index) / 10000 })
		if err != nil {
			t.Fatal(err)
		}
		for i := range left {
			left[i] += float32(chunks) * .1
			right[i] -= float32(chunks) * .2
		}
		if err := work.accept(context.Background(), 0, left, right); err != nil {
			t.Fatal(err)
		}
		err = work.advance(context.Background(), func(_, start int, left, right []float32) error {
			for i := range left {
				absolute := start + i + 500
				var weighted, denominator float64
				// Independent direct timeline oracle: derive each intersecting window
				// from its absolute origin, rather than from assembler state/ring indices.
				for origin := 0; origin < length+1000; origin += 500 {
					relative := absolute - origin
					if relative < 0 || relative >= 1000 {
						continue
					}
					weight := 1.0
					if relative < 100 && origin != 0 {
						weight = float64(relative) / 99
					}
					if relative >= 900 && origin+1000 < length+1000 {
						weight = float64(999-relative) / 99
					}
					weighted += weight * float64(origin/500)
					denominator += weight
				}
				index := float64(start+i) / 10000
				if math.Abs(float64(left[i])-(index+.1*weighted/denominator)) > 3e-7 || math.Abs(float64(right[i])-(index-.2*weighted/denominator)) > 3e-7 {
					t.Fatalf("context seam mismatch source%d left%g right%g", start+i, left[i], right[i])
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		chunks++
	}
	if chunks != 8 {
		t.Fatal("unexpected original chunk count", chunks)
	}
}
func TestChunkAssemblyRejectsMissingHeadsAndCancellation(t *testing.T) {
	work, err := newChunkAssembler(129, 1000, 2)
	if err != nil {
		t.Fatal(err)
	}
	consume := func(_, _ int, _, _ []float32) error { return nil }
	if err := work.advance(context.Background(), consume); err == nil {
		t.Fatal("incomplete head set advanced")
	}
	left, right, err := work.input(context.Background(), func(_, index int) float32 { return float32(index) })
	if err != nil {
		t.Fatal(err)
	}
	if err := work.accept(context.Background(), 0, left, right); err != nil {
		t.Fatal(err)
	}
	if err := work.accept(context.Background(), 0, left, right); err == nil {
		t.Fatal("duplicate head accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := work.input(ctx, func(_, _ int) float32 { return 1 }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := work.accept(ctx, 1, left, right); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := newChunkAssembler(0, 1000, 1); err == nil {
		t.Fatal("empty source accepted")
	}
}
