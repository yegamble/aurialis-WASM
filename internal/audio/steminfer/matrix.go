// Package steminfer implements private bounded inference primitives for the
// licensed five-head Mega53 subset. No public separation capability is enabled.
package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

import (
	"context"
	"errors"
)

const matrixLimit = 4096
const matrixRowsPerCall = 128

// multiply computes left * right (or right-transposed) with row-major storage.
// Bounds and cancellation are checked before every bounded backend call.
func multiply(ctx context.Context, dst, left, right []float32, rows, columns, inner int, transposeRight bool) error {
	if ctx == nil || rows < 1 || rows > matrixLimit || columns < 1 || columns > matrixLimit || inner < 1 || inner > matrixLimit || len(dst) != rows*columns || len(left) != rows*inner || len(right) != columns*inner {
		return errors.New("invalid bounded matrix geometry or context")
	}
	for first := 0; first < rows; first += matrixRowsPerCall {
		if err := ctx.Err(); err != nil {
			return err
		}
		count := min(matrixRowsPerCall, rows-first)
		multiplyBackend(dst[first*columns:(first+count)*columns], left[first*inner:(first+count)*inner], right, count, columns, inner, transposeRight)
	}
	return nil
}
