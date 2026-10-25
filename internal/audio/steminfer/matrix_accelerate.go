//go:build darwin && cgo

package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

/*
#cgo CFLAGS: -DACCELERATE_NEW_LAPACK -DACCELERATE_LAPACK_ILP64
#cgo LDFLAGS: -framework Accelerate
#include <Accelerate/Accelerate.h>
static void aurialis_stem_multiply(float *out, const float *left, const float *right, int m, int n, int k, int transposed) {
 cblas_sgemm(CblasRowMajor, CblasNoTrans, transposed ? CblasTrans : CblasNoTrans,
  m,n,k,1.0f,left,k,right,transposed ? k : n,0.0f,out,n);
}
*/
import "C"

func matrixBackendName() string { return "apple-accelerate" }
func multiplyBackend(dst, left, right []float32, rows, columns, inner int, transposeRight bool) {
	transposed := 0
	if transposeRight {
		transposed = 1
	}
	C.aurialis_stem_multiply((*C.float)(&dst[0]), (*C.float)(&left[0]), (*C.float)(&right[0]), C.int(rows), C.int(columns), C.int(inner), C.int(transposed))
}
