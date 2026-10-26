package steminfer

// cspell:words softmax steminfer GELU

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestExactFormActivationsAgainstIndependentScalarFormula(t *testing.T) {
	values := make([]float32, 3001)
	for i := range values {
		values[i] = float32(i-1500) / 100
	}
	original := append([]float32(nil), values...)
	if err := applyGELU(context.Background(), values); err != nil {
		t.Fatal(err)
	}
	for i, x := range original {
		want := .5 * float64(x) * (1 + math.Erf(float64(x)/math.Sqrt2))
		if math.Abs(float64(values[i])-want) > 2e-6 {
			t.Fatalf("GELU(%g) got%g want%g", x, values[i], want)
		}
	}
	copy(values, original)
	if err := applyTanh(context.Background(), values); err != nil {
		t.Fatal(err)
	}
	for i, x := range original {
		if math.Abs(float64(values[i])-math.Tanh(float64(x))) > 2e-7 {
			t.Fatalf("tanh(%g) got%g", x, values[i])
		}
	}
}
func TestFullKeySoftmaxStableNormalizedAndBounded(t *testing.T) {
	for _, width := range []int{1, 62, maximumSequence} {
		values := make([]float32, attentionTile*width)
		for i := range values {
			values[i] = float32((i*71)%1009-504) * 4
		}
		original := append([]float32(nil), values...)
		if err := attentionSoftmax(context.Background(), values, attentionTile, width); err != nil {
			t.Fatal(err)
		}
		for row := range attentionTile {
			maximum := float64(-math.MaxFloat32)
			for _, x := range original[row*width : (row+1)*width] {
				maximum = math.Max(maximum, float64(x)*.125)
			}
			var sum, gotSum float64
			for _, x := range original[row*width : (row+1)*width] {
				sum += math.Exp(float64(x)*.125 - maximum)
			}
			for i, x := range original[row*width : (row+1)*width] {
				got := float64(values[row*width+i])
				want := math.Exp(float64(x)*.125-maximum) / sum
				if !finite32(float32(got)) || math.Abs(got-want) > 1e-7 {
					t.Fatalf("softmax width%d index%d got%g want%g", width, i, got, want)
				}
				gotSum += got
			}
			if math.Abs(gotSum-1) > 2e-7 {
				t.Fatalf("softmax sum%g", gotSum)
			}
		}
	}
	if err := attentionSoftmax(context.Background(), []float32{1}, attentionTile+1, 1); err == nil {
		t.Fatal("unbounded tile accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := attentionSoftmax(ctx, []float32{1}, 1, 1); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, apply := range []func(context.Context, []float32) error{applyGELU, applyTanh} {
		if err := apply(ctx, make([]float32, nonlinearTile+1)); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if err := apply(nil, nil); err == nil {
			t.Fatal("nil context accepted")
		}
	}
}
func BenchmarkCompleteAttentionTile(b *testing.B) {
	values := make([]float32, attentionTile*862)
	b.ReportAllocs()
	for b.Loop() {
		if err := attentionSoftmax(context.Background(), values, attentionTile, 862); err != nil {
			b.Fatal(err)
		}
	}
}
func BenchmarkExactFormGELUTile(b *testing.B) {
	values := make([]float32, nonlinearTile)
	b.ReportAllocs()
	for b.Loop() {
		if err := applyGELU(context.Background(), values); err != nil {
			b.Fatal(err)
		}
	}
}
