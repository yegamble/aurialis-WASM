//go:build !darwin || !cgo

package steminfer

// cspell:words softmax steminfer GELU

import "math"

func softmaxBackend(values []float32, rows, width int) {
	for row := range rows {
		v := values[row*width : (row+1)*width]
		maximum := softmaxMaximum(v)
		sum := softmaxExponentials(v, maximum)
		normalizeSoftmax(v, sum)
	}
}
func geluBackend(values []float32) {
	for i, x := range values {
		values[i] = float32(.5 * float64(x) * (1 + math.Erf(float64(x)/math.Sqrt2)))
	}
}
func tanhBackend(values []float32) {
	for i, x := range values {
		values[i] = float32(math.Tanh(float64(x)))
	}
}

func scalarSoftmaxMaximum(values []float32) float32 {
	maximum := float32(-math.MaxFloat32)
	for _, x := range values {
		maximum = max(maximum, x*.125)
	}
	return maximum
}
