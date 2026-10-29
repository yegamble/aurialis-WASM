//go:build (!darwin || !cgo) && (!amd64 || (!linux && !windows) || noasm || safe || gccgo)

package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

func matrixBackendName() string { return "portable-go" }
func multiplyBackend(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	multiplyPortable(dst, left, right, rows, columns, inner, transposeRight)
}
