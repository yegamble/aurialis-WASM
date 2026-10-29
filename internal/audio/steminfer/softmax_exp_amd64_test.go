//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words noasm nonpositive Exponentials ULP softmax AVX2 FMA

import (
	"math"
	"testing"
)

func TestVectorExpFloat32ULPAgainstScalar(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	values := make([]float32, 0, 140000)
	// Uniform real-domain and bit-pattern samples cover normal/subnormal
	// outputs, tiny arguments, and the endpoints of the vector contract.
	seed := uint32(0x572391)
	for i := range 65537 {
		values = append(values, -104*float32(i)/65536)
		seed = seed*1664525 + 1013904223
		values = append(values, -math.Float32frombits(seed%math.Float32bits(104)))
	}
	for k := -150; k <= 0; k++ {
		x := float32((float64(k) + .5) * math.Ln2)
		if x <= 0 && x >= -104 {
			values = append(values, math.Nextafter32(x, float32(math.Inf(-1))), x, math.Nextafter32(x, 0))
		}
	}
	underflow := float32(math.Log(float64(math.SmallestNonzeroFloat32) * .5))
	values = append(values, math.Nextafter32(underflow, float32(math.Inf(-1))), underflow, math.Nextafter32(underflow, 0))
	values = append(values, 0, float32(math.Copysign(0, -1)), -104, math.Nextafter32(-104, 0))
	original := append([]float32(nil), values...)
	expSoftmaxValues(values, true)
	var worst uint32
	for i, x := range original {
		want := float32(math.Exp(float64(x)))
		gotBits, wantBits := math.Float32bits(values[i]), math.Float32bits(want)
		var distance uint32
		if gotBits > wantBits {
			distance = gotBits - wantBits
		} else {
			distance = wantBits - gotBits
		}
		worst = max(worst, distance)
		if distance > 1 {
			t.Fatalf("exp(%g) got%.9g want%.9g: %d ULP", x, values[i], want, distance)
		}
	}
	t.Logf("%d nonpositive exponential probes; maximum float32 distance %d ULP", len(values), worst)
}

func TestVectorExpExceptionalAndUnderflowFallback(t *testing.T) {
	for _, source := range [][]float32{
		{0, -832, -840, -100000},
		{0, float32(math.Inf(-1)), float32(math.Inf(1)), float32(math.NaN())},
		{-1, 0, 1, 16, 32},
	} {
		values := append([]float32(nil), source...)
		softmaxExponentials(values, 0)
		for i, x := range source {
			want := float32(math.Exp(float64(x * .125)))
			if math.IsNaN(float64(want)) {
				if !math.IsNaN(float64(values[i])) {
					t.Fatal("NaN was hidden")
				}
			} else if math.Float32bits(values[i]) != math.Float32bits(want) {
				t.Fatalf("exceptional exp input%g got%g want%g", x, values[i], want)
			}
		}
	}
}

func TestVectorSoftmaxMaximumAndNormalization(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	for _, width := range []int{1, 7, 8, 9, 62, maximumSequence} {
		values := make([]float32, width)
		for i := range values {
			values[i] = float32(math.Sin(float64(i)*.37) * 100)
		}
		for _, special := range []float32{0, float32(math.Copysign(0, -1)), math.SmallestNonzeroFloat32, -math.SmallestNonzeroFloat32, math.MaxFloat32, -math.MaxFloat32, float32(math.Inf(1)), float32(math.Inf(-1)), float32(math.NaN())} {
			values[width/2] = special
			got, want := softmaxMaximum(values), scalarSoftmaxMaximum(values)
			if math.IsNaN(float64(want)) {
				if !math.IsNaN(float64(got)) {
					t.Fatal("maximum hid NaN")
				}
			} else if got != want {
				t.Fatalf("maximum width%d got%g want%g", width, got, want)
			}
		}
		for _, sum := range []float64{1, 1.7, 1723, 0, math.Inf(1), math.NaN()} {
			for i := range values {
				values[i] = float32(math.Exp(-float64(i % 121)))
			}
			original := append([]float32(nil), values...)
			normalizeSoftmax(values, sum)
			for i, x := range original {
				want := float32(float64(x) / sum)
				if math.IsNaN(float64(want)) {
					if !math.IsNaN(float64(values[i])) {
						t.Fatal("division hid NaN")
					}
				} else if math.Float32bits(values[i]) != math.Float32bits(want) {
					t.Fatalf("division width%d sum%g got%g want%g", width, sum, values[i], want)
				}
			}
		}
	}
}

func TestVectorGELUCandidateAgainstErf(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	values := make([]float32, 30001)
	for i := range values {
		values[i] = float32(i-15000) / 1000
	}
	values = append(values, 0, float32(math.Copysign(0, -1)), math.MaxFloat32, -math.MaxFloat32, float32(math.Inf(1)), float32(math.Inf(-1)), float32(math.NaN()))
	original := append([]float32(nil), values...)
	geluVectorCandidate(values)
	var worst float64
	for i, x := range original {
		want := .5 * float64(x) * (1 + math.Erf(float64(x)/math.Sqrt2))
		got := float64(values[i])
		if math.IsNaN(want) {
			if !math.IsNaN(got) {
				t.Fatal("GELU hid NaN")
			}
		} else if math.IsInf(want, 0) || x == 0 {
			if math.Float32bits(values[i]) != math.Float32bits(float32(want)) {
				t.Fatal("GELU exceptional or signed-zero changed")
			}
		} else {
			difference := math.Abs(got - want)
			worst = math.Max(worst, difference)
			if difference > 2e-6 {
				t.Fatalf("GELU(%g) got%g want%g error%g", x, got, want, difference)
			}
		}
	}
	t.Logf("GELU approximation maximum absolute error %.9g", worst)
}
