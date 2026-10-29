//go:build (linux || windows) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words gonum sgemm SSE3

import (
	"golang.org/x/sys/cpu"
	"gonum.org/v1/gonum/blas"
	"gonum.org/v1/gonum/blas/gonum"
)

func matrixBackendName() string {
	if hasPackedMatrix() {
		return "packed-avx2-fma"
	}
	if !cpu.X86.HasSSE3 {
		return "portable-go"
	}
	return "gonum-sse3"
}
func multiplyBackend(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	if hasPackedMatrix() {
		multiplyPacked(dst, left, right, rows, columns, inner, transposeRight)
		return
	}
	// Gonum's f32.DotUnitary uses SSE3 HADDPS. Check the real CPU even on
	// baseline GOAMD64=v1 builds; unsupported hardware keeps the scalar path.
	if !cpu.X86.HasSSE3 {
		multiplyPortable(dst, left, right, rows, columns, inner, transposeRight)
		return
	}
	multiplyGonum(dst, left, right, rows, columns, inner, transposeRight)
}
func multiplyGonum(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	transpose, leading := blas.NoTrans, columns
	if transposeRight {
		transpose, leading = blas.Trans, inner
	}
	// In pinned Gonum v0.17.0, fewer than four 64x64 output blocks selects
	// serial SGEMM. At most 128 rows x 64 columns avoids nested goroutines,
	// per-call allocations and oversubscription of the existing bounded lanes.
	const columnsPerCall = 64
	for first := 0; first < columns; first += columnsPerCall {
		count := min(columnsPerCall, columns-first)
		offset := first
		if transposeRight {
			offset = first * inner
		}
		gonum.Implementation{}.Sgemm(blas.NoTrans, transpose, rows, count, inner, 1, left, inner, right[offset:], leading, 0, dst[first:], columns)
	}
}
