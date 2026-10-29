//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words noasm noescape nonpositive Exponentials softmax AVX2 FMA ULP GELU Abramowitz Stegun

import "math"

func softmaxExponentials(values []float32, maximum float32) float64 {
	vector := hasPackedMatrix()
	for i, x := range values {
		shifted := x*.125 - maximum
		values[i] = shifted
		// The vector reduction only needs the nonpositive softmax domain whose
		// exponential can survive float32 rounding. Scalar math.Exp preserves
		// all exceptional values and the deep-underflow behavior unchanged.
		if !(shifted >= -104 && shifted <= 0) {
			vector = false
		}
	}
	expSoftmaxValues(values, vector)
	var sum float64
	for _, value := range values {
		sum += float64(value)
	}
	return sum
}

func expSoftmaxValues(values []float32, vector bool) {
	first := 0
	if vector && len(values) >= 4 {
		first = len(values) / 4 * 4
		expFourLanes(&values[0], first)
	}
	for i := first; i < len(values); i++ {
		values[i] = float32(math.Exp(float64(values[i])))
	}
}

// expFourLanes applies the Go amd64 math.Exp float64 reduction and polynomial
// in four lanes, rounding to float32 only at the output. Inputs are finite
// and in [-104,0], count is positive and divisible by four, and AVX2/FMA is
// available. Exceptional arguments always stay on the scalar path.
//
//go:noescape
func expFourLanes(values *float32, count int)

func softmaxMaximum(values []float32) float32 {
	if hasPackedMatrix() && len(values) >= 8 {
		count := len(values) / 8 * 8
		maximum := maximumFiniteSoftmax(&values[0], count)
		if !math.IsNaN(float64(maximum)) {
			maximum *= .125
			for _, x := range values[count:] {
				maximum = max(maximum, x*.125)
			}
			return maximum
		}
	}
	return scalarSoftmaxMaximum(values)
}

func normalizeSoftmax(values []float32, sum float64) {
	first := 0
	if hasPackedMatrix() && len(values) >= 4 && sum > 0 && !math.IsInf(sum, 0) {
		first = len(values) / 4 * 4
		divideSoftmaxFourLanes(&values[0], first, sum)
	}
	for i := first; i < len(values); i++ {
		values[i] = float32(float64(values[i]) / sum)
	}
}

// maximumFiniteSoftmax returns the raw finite maximum, or NaN when any input
// is nonfinite so the caller recomputes the exact scalar exceptional case.
// Only softmax consumes this result: either sign of a zero maximum yields
// the same exponential. count is positive and divisible by eight.
//
//go:noescape
func maximumFiniteSoftmax(values *float32, count int) float32

// divideSoftmaxFourLanes preserves the scalar float64 division and float32
// rounding for each value independently. It does not reassociate the sum.
//
//go:noescape
func divideSoftmaxFourLanes(values *float32, count int, sum float64)

// geluVectorCandidate uses the same Abramowitz/Stegun 7.1.26 approximation
// as the separately qualified Apple implementation. This differs from the
// portable math.Erf path: it is a bounded approximation, not exact GELU.
// The model's independent 1e-4 / 80 dB qualification gate remains mandatory.
func geluVectorCandidate(values []float32) bool {
	if !hasPackedMatrix() {
		return false
	}
	const batch = 1024
	var t, exponent [batch]float32
	for first := 0; first < len(values); first += batch {
		count := min(batch, len(values)-first)
		v := values[first : first+count]
		vector := true
		for i, x := range v {
			if !finite32(x) {
				t[i], exponent[i] = 0, 0
				continue
			}
			z := x
			if z < 0 {
				z = -z
			}
			z *= .7071067811865475244
			t[i] = 1 / (1 + .3275911*z)
			exponent[i] = -z * z
			if exponent[i] < -104 {
				vector = false
			}
		}
		expSoftmaxValues(exponent[:count], vector)
		for i, x := range v {
			if !finite32(x) {
				v[i] = float32(.5 * float64(x) * (1 + math.Erf(float64(x)/math.Sqrt2)))
				continue
			}
			tt := t[i]
			polynomial := tt * (.254829592 + tt*(-.284496736+tt*(1.421413741+tt*(-1.453152027+tt*1.061405429))))
			erf := 1 - polynomial*exponent[i]
			if x < 0 {
				erf = -erf
			}
			v[i] = .5 * x * (1 + erf)
		}
	}
	return true
}
