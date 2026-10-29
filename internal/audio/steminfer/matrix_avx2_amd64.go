//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words noasm blas noescape AVX2 FMA sgemm gonum

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
	clear(dst)
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
			// A partial row uses the identical ordered FMA accumulation. Sending
			// it to a dot-product reduction would change a sequence's arithmetic
			// when batching moves that row into a complete four-row tile.
			for row := fullRows; row < rows; row++ {
				packedKernel1x16(&dst[row*columns+column], &left[row*inner+first], &panel[0], depth)
			}
		}
	}
	// The right edge has the same columns in every batching layout, so it
	// retains the SSE3 implementation for every row. Neither path reads
	// padding beyond the caller's exact slice geometry.
	transpose, leading := blas.NoTrans, columns
	if transposeRight {
		transpose, leading = blas.Trans, inner
	}
	if fullColumns < columns {
		offset := fullColumns
		if transposeRight {
			offset *= inner
		}
		gonum.Implementation{}.Sgemm(blas.NoTrans, transpose, rows, columns-fullColumns, inner, 1, left, inner, right[offset:], leading, 0, dst[fullColumns:], columns)
	}
}

// packedKernel4x16 adds left[4,depth] * panel[depth,16] to dst[4,16].
// Strides are byte counts. All pointers refer to bounds checked Go slices.
// The AVX2/FMA CPU check must precede every entry through multiplyBackend.
//
//go:noescape
func packedKernel4x16(dst, left, panel *float32, leftStride, dstStride, depth int)

// packedKernel1x16 is the one-row edge of packedKernel4x16, with exactly the
// same float32 FMA order. depth is positive and at most packedInner.
//
//go:noescape
func packedKernel1x16(dst, left, panel *float32, depth int)
