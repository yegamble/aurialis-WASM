package dsp

import (
	"math"
	"testing"
)

func checkStudioExactExtremaBits(t *testing.T, a, b float64) {
	t.Helper()
	gotMax, wantMax := math.Float64bits(studioExactMax(a, b)), math.Float64bits(math.Max(a, b))
	gotMin, wantMin := math.Float64bits(studioExactMin(a, b)), math.Float64bits(math.Min(a, b))
	if gotMax != wantMax || gotMin != wantMin {
		t.Fatalf("a%x b%x: max%x want%x; min%x want%x", math.Float64bits(a), math.Float64bits(b), gotMax, wantMax, gotMin, wantMin)
	}
}

func TestStudioExactExtremaBitContract(t *testing.T) {
	clock := float64(int64(9007199254740991))
	edges := []float64{
		0, math.Copysign(0, -1), math.SmallestNonzeroFloat64, -math.SmallestNonzeroFloat64,
		math.Float64frombits(0x0010000000000000), math.Float64frombits(0x8010000000000000),
		math.Nextafter(1, 0), 1, math.Nextafter(1, 2), -1,
		math.MaxFloat64, -math.MaxFloat64, math.Inf(1), math.Inf(-1),
		clock, math.Nextafter(clock, math.Inf(1)), math.Nextafter(clock, math.Inf(-1)),
		float64(int64(math.MaxInt64)), float64(int64(math.MinInt64)),
		math.Float64frombits(0x7ff8000000000001), math.Float64frombits(0xfff8000000000001),
		math.Float64frombits(0x7ff8123456789abc), math.Float64frombits(0xfff8abcdef012345),
		math.Float64frombits(0x7ff0000000000001), math.Float64frombits(0xfff0000000000001),
	}
	for _, a := range edges {
		for _, b := range edges {
			checkStudioExactExtremaBits(t, a, b)
		}
	}
	// Every random input is an arbitrary bit pattern, including signed zeros,
	// subnormals, infinities and multiple quiet/signaling NaN representations.
	seed := uint64(0x6e417d0b2f9c3a85)
	for range 65536 {
		seed = seed*6364136223846793005 + 1442695040888963407
		a := math.Float64frombits(seed)
		seed = seed*6364136223846793005 + 1442695040888963407
		b := math.Float64frombits(seed)
		checkStudioExactExtremaBits(t, a, b)
		checkStudioExactExtremaBits(t, b, a)
	}
}
