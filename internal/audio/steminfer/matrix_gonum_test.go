//go:build (linux || windows) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words noasm retile gonum SSE3 sgemm

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/cpu"
)

func TestGonumMatrixLayoutsAgainstFloat64(t *testing.T) {
	if !cpu.X86.HasSSE3 {
		t.Skip("SSE3 is unavailable; scalar backend remains active")
	}
	for _, shape := range [][3]int{{1, 1, 1}, {7, 13, 29}, {128, 65, 257}} {
		for _, transpose := range []bool{false, true} {
			rows, columns, inner := shape[0], shape[1], shape[2]
			left, right, out := make([]float32, rows*inner), make([]float32, columns*inner), make([]float32, rows*columns)
			for i := range left {
				left[i] = float32(i%37-18) / 32
			}
			for i := range right {
				right[i] = float32(i%29-14) / 16
			}
			for i := range out {
				out[i] = float32(math.NaN())
			}
			multiplyGonum(out, left, right, rows, columns, inner, transpose)
			for row := range rows {
				for column := range columns {
					want := 0.
					for k := range inner {
						offset := k*columns + column
						if transpose {
							offset = column*inner + k
						}
						want += float64(left[row*inner+k]) * float64(right[offset])
					}
					if delta := math.Abs(float64(out[row*columns+column]) - want); math.IsNaN(delta) || delta > 2e-5*math.Max(1, math.Abs(want)) {
						t.Fatalf("shape%v transpose%v row%d column%d delta%g", shape, transpose, row, column, delta)
					}
				}
			}
		}
	}
}
func TestGonumMatrixCallsHaveNoNestedWorkerAllocations(t *testing.T) {
	if !cpu.X86.HasSSE3 {
		t.Skip("SSE3 is unavailable")
	}
	if matrixRowsPerCall > 128 {
		t.Fatal("retile SGEMM before increasing the row cancellation bound")
	}
	const columns, inner = 1536, 256
	left, right, out := make([]float32, matrixRowsPerCall*inner), make([]float32, columns*inner), make([]float32, matrixRowsPerCall*columns)
	allocations := testing.AllocsPerRun(3, func() { multiplyGonum(out, left, right, matrixRowsPerCall, columns, inner, true) })
	if allocations != 0 {
		t.Fatalf("SGEMM spawned workers or allocated scratch: %g", allocations)
	}
}
func TestGonumUnsupportedCPUStaysUnavailable(t *testing.T) {
	if os.Getenv("AURIALIS_STEM_EXPECT_SCALAR") != "1" {
		t.Skip("explicit CPU-feature-disabled subprocess probe")
	}
	if cpu.X86.HasSSE3 || Backend() != "portable-go" || Accelerated() {
		t.Fatalf("unsupported CPU selected %s", Backend())
	}
}
func TestGonumCancellationIsBoundedByOneRowCall(t *testing.T) {
	if !cpu.X86.HasSSE3 {
		t.Skip("SSE3 is unavailable")
	}
	const rows, columns, inner = 256, 2048, 2048
	left, right, out := make([]float32, rows*inner), make([]float32, columns*inner), make([]float32, rows*columns)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(time.Millisecond, cancel)
	defer timer.Stop()
	started := time.Now()
	err := multiply(ctx, out, left, right, rows, columns, inner, true)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("matrix ignored cancellation", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("matrix cancellation exceeded one second: %v", elapsed)
	}
}
func BenchmarkNativeGonumKernels(b *testing.B) {
	if !cpu.X86.HasSSE3 {
		b.Skip("SSE3 is unavailable")
	}
	for _, test := range []struct {
		name                 string
		rows, columns, inner int
		transpose            bool
	}{
		{"projection", 128, 1536, 256, true}, {"attention-scores", 128, 862, 64, true}, {"attention-values", 128, 64, 862, false},
	} {
		for _, portable := range []bool{false, true} {
			b.Run(fmt.Sprintf("%s/scalar%v", test.name, portable), func(b *testing.B) {
				left, right, out := make([]float32, test.rows*test.inner), make([]float32, test.columns*test.inner), make([]float32, test.rows*test.columns)
				for i := range left {
					left[i] = float32(i%37-18) / 32
				}
				for i := range right {
					right[i] = float32(i%29-14) / 16
				}
				b.ReportAllocs()
				b.ResetTimer()
				for b.Loop() {
					if portable {
						multiplyPortable(out, left, right, test.rows, test.columns, test.inner, test.transpose)
					} else {
						multiplyGonum(out, left, right, test.rows, test.columns, test.inner, test.transpose)
					}
				}
			})
		}
	}
}
