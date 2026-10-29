//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words AVX2 FMA sgemm gonum

import (
	"golang.org/x/sys/cpu"
	"gonum.org/v1/gonum/blas"
	"gonum.org/v1/gonum/blas/gonum"
)

const packedInner = 128
const packedColumns = 16

func hasPackedMatrix() bool { return cpu.X86.HasSSE3 && cpu.X86.HasAVX2 && cpu.X86.HasFMA }

// multiplyPacked uses a conventional register-blocked outer-product kernel.
// One 8 KiB right-hand panel is reused across all four-row tiles. The caller
// bounds rows to 128 and checks cancellation between calls. Packing is local
// to each call, so concurrent inference lanes share no mutable scratch.
func multiplyPacked(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	var panel [packedInner * packedColumns]float32
	fullRows, fullColumns := rows/4*4, columns/packedColumns*packedColumns
	clear(dst[:fullRows*columns])
	for column := 0; column < fullColumns; column += packedColumns {
		for first := 0; first < inner; first += packedInner {
			depth := min(packedInner, inner-first)
			if transposeRight {
				for c := range packedColumns {
					source := right[(column+c)*inner+first:][:depth]
					for k, value := range source {
						panel[k*packedColumns+c] = value
					}
				}
			} else {
				for k := range depth {
					copy(panel[k*packedColumns:(k+1)*packedColumns], right[(first+k)*columns+column:][:packedColumns])
				}
			}
			for row := 0; row < fullRows; row += 4 {
				packedKernel4x16(&dst[row*columns+column], &left[row*inner+first], &panel[0], inner*4, columns*4, depth)
			}
		}
	}
	// The small right/bottom edges retain the audited SSE3 implementation;
	// neither path reads padding beyond the caller's exact slice geometry.
	transpose, leading := blas.NoTrans, columns
	if transposeRight {
		transpose, leading = blas.Trans, inner
	}
	if fullColumns < columns && fullRows > 0 {
		offset := fullColumns
		if transposeRight {
			offset *= inner
		}
		gonum.Implementation{}.Sgemm(blas.NoTrans, transpose, fullRows, columns-fullColumns, inner, 1, left, inner, right[offset:], leading, 0, dst[fullColumns:], columns)
	}
	if fullRows < rows {
		// Split columns as in the fallback, preventing Gonum's nested workers.
		for first := 0; first < columns; first += 64 {
			count, offset := min(64, columns-first), first
			if transposeRight {
				offset *= inner
			}
			gonum.Implementation{}.Sgemm(blas.NoTrans, transpose, rows-fullRows, count, inner, 1, left[fullRows*inner:], inner, right[offset:], leading, 0, dst[fullRows*columns+first:], columns)
		}
	}
}

// packedKernel4x16 adds left[4,depth] * panel[depth,16] to dst[4,16].
// Strides are byte counts. All pointers refer to bounds checked Go slices.
// The AVX2/FMA CPU check must precede every entry through multiplyBackend.
//
//go:noescape
func packedKernel4x16(dst, left, panel *float32, leftStride, dstStride, depth int)
