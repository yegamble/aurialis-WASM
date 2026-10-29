//go:build !darwin || !cgo

package steminfer

// cspell:words softmax steminfer GELU

import "math"

func softmaxBackend(values []float32, rows, width int) {
	for row := range rows {
		v := values[row*width : (row+1)*width]
		maximum := float32(-math.MaxFloat32)
		for _, x := range v {
			maximum = max(maximum, x*.125)
		}
		sum := softmaxExponentials(v, maximum)
		for i := range v {
			v[i] = float32(float64(v[i]) / sum)
		}
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
