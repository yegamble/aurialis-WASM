//go:build !darwin || !cgo

package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

func matrixBackendName() string { return "portable-go" }
func multiplyBackend(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	for row := range rows {
		for column := range columns {
			var sum float32
			if transposeRight {
				for k := range inner {
					sum += left[row*inner+k] * right[column*inner+k]
				}
			} else {
				for k := range inner {
					sum += left[row*inner+k] * right[k*columns+column]
				}
			}
			dst[row*columns+column] = sum
		}
	}
}
