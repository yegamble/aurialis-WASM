package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestMatrixLayoutsAndCancellation(t *testing.T) {
	for _, transpose := range []bool{false, true} {
		for _, dimensions := range [][3]int{{1, 1, 1}, {3, 5, 7}, {129, 17, 32}} {
			rows, columns, inner := dimensions[0], dimensions[1], dimensions[2]
			left, right := make([]float32, rows*inner), make([]float32, columns*inner)
			output := make([]float32, rows*columns)
			for i := range left {
				left[i] = float32(i%37-18) / 32
			}
			for i := range right {
				right[i] = float32(i%29-14) / 16
			}
			if err := multiply(context.Background(), output, left, right, rows, columns, inner, transpose); err != nil {
				t.Fatal(err)
			}
			for row := range rows {
				for column := range columns {
					sum := 0.
					for k := range inner {
						index := k*columns + column
						if transpose {
							index = column*inner + k
						}
						sum += float64(left[row*inner+k]) * float64(right[index])
					}
					if math.Abs(float64(output[row*columns+column])-sum) > 1e-5 {
						t.Fatal("matrix layout changed", transpose, dimensions, row, column)
					}
				}
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := []float32{42}
	if err := multiply(ctx, out, []float32{1}, []float32{2}, 1, 1, 1, true); !errors.Is(err, context.Canceled) || out[0] != 42 {
		t.Fatal("canceled matrix changed output", err)
	}
	if err := multiply(context.Background(), out, nil, nil, 4097, 1, 1, true); err == nil {
		t.Fatal("oversized matrix accepted")
	}
}
func BenchmarkMatrixProjection(b *testing.B) {
	const rows, columns, inner = 862, 1536, 256
	left, right, out := make([]float32, rows*inner), make([]float32, columns*inner), make([]float32, rows*columns)
	for i := range left {
		left[i] = float32(i%37-18) / 32
	}
	for i := range right {
		right[i] = float32(i%29-14) / 16
	}
	b.ReportAllocs()
	b.ReportMetric(float64(2*rows*columns*inner)/1e9, "GFLOP/op")
	b.Log(matrixBackendName())
	b.ResetTimer()
	for range b.N {
		if err := multiply(context.Background(), out, left, right, rows, columns, inner, true); err != nil {
			b.Fatal(err)
		}
	}
}
