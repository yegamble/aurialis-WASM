//go:build (!darwin || !cgo) && (!amd64 || noasm || safe || gccgo)

package steminfer

// cspell:words noasm Exponentials

import "math"

func softmaxExponentials(values []float32, maximum float32) float64 {
	var sum float64
	for i, x := range values {
		values[i] = float32(math.Exp(float64(x*.125 - maximum)))
		sum += float64(values[i])
	}
	return sum
}
