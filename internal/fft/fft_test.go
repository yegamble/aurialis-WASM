package fft

import (
	"fmt"
	"math"
	"math/cmplx"
	"sync"
	"testing"
)

func testSignal(size int) []complex128 {
	values := make([]complex128, size)
	for i := range values {
		values[i] = complex(math.Sin(float64(i)*.73)+.13*float64(i%7), math.Cos(float64(i)*.31)-.07*float64(i%11))
	}
	return values
}
func TestPreparedPlanMatchesIndependentDFT(t *testing.T) {
	for _, strategy := range []TwiddleStrategy{DirectTwiddles, RecursiveTwiddles} {
		for _, size := range []int{1, 2, 8, 32} {
			for _, inverse := range []bool{false, true} {
				values := testSignal(size)
				want := make([]complex128, size)
				sign := -1.0
				if inverse {
					sign = 1
				}
				for k := range want {
					for i, value := range values {
						angle := sign * 2 * math.Pi * float64(k*i) / float64(size)
						want[k] += value * complex(math.Cos(angle), math.Sin(angle))
					}
					if inverse {
						want[k] /= complex(float64(size), 0)
					}
				}
				New(size, strategy).Transform(values, inverse)
				for i := range values {
					if delta := cmplx.Abs(values[i] - want[i]); delta > 2e-12 {
						t.Fatalf("strategy%d size%d inverse%v bin%d delta%g", strategy, size, inverse, i, delta)
					}
				}
			}
		}
	}
}
func TestPreparedPlanPreservesLegacyArithmeticBounds(t *testing.T) {
	for _, strategy := range []TwiddleStrategy{DirectTwiddles, RecursiveTwiddles} {
		for _, size := range []int{1, 2, 8, 1024, 2048, 4096, 8192, 16384, 32768, 65536} {
			for _, inverse := range []bool{false, true} {
				values := testSignal(size)
				want := append([]complex128(nil), values...)
				if strategy == DirectTwiddles {
					newLegacyDirectPlan(size).run(want, inverse)
				} else {
					legacyRecursive(want, inverse)
				}
				New(size, strategy).Transform(values, inverse)
				delta, peak := 0.0, 0.0
				mismatches := 0
				for i := range values {
					delta = math.Max(delta, cmplx.Abs(values[i]-want[i]))
					peak = math.Max(peak, cmplx.Abs(want[i]))
					if math.Float64bits(real(values[i])) != math.Float64bits(real(want[i])) || math.Float64bits(imag(values[i])) != math.Float64bits(imag(want[i])) {
						mismatches++
					}
				}
				t.Logf("strategy%d size%d inverse%v mismatches%d abs%g relative%g", strategy, size, inverse, mismatches, delta, delta/math.Max(1, peak))
				if strategy == DirectTwiddles && mismatches != 0 {
					t.Fatal("direct roots changed legacy bit patterns")
				}
				if delta > 5e-15*math.Max(1, peak) {
					t.Fatal("legacy arithmetic changed beyond rounding error bound")
				}

			}
		}
	}
}
func TestPreparedPlanInverseAndZeroTransformAllocations(t *testing.T) {
	for _, strategy := range []TwiddleStrategy{DirectTwiddles, RecursiveTwiddles} {
		plan := New(2048, strategy)
		source := testSignal(2048)
		values := make([]complex128, len(source))
		allocations := testing.AllocsPerRun(20, func() { copy(values, source); plan.Transform(values, false); plan.Transform(values, true) })
		if allocations != 0 {
			t.Fatalf("strategy%d allocated %g per pair", strategy, allocations)
		}
		for i := range values {
			if cmplx.Abs(values[i]-source[i]) > 1e-11 {
				t.Fatalf("inverse changed sample%d", i)
			}
		}
	}
}
func TestPreparedPlanCanBeSharedByIndependentWorkspaces(t *testing.T) {
	plan := New(32, RecursiveTwiddles)
	var group sync.WaitGroup
	for range 4 {
		group.Go(func() {
			values := testSignal(32)
			want := values[7]
			plan.Transform(values, false)
			plan.Transform(values, true)
			if cmplx.Abs(values[7]-want) > 1e-12 {
				t.Error("shared plan changed input")
			}
		})
	}
	group.Wait()
}
func TestPlanRejectsInvalidProgrammingInputs(t *testing.T) {
	for _, operation := range []func(){func() { New(0, DirectTwiddles) }, func() { New(3, DirectTwiddles) }, func() { New(4, TwiddleStrategy(255)) }, func() { New(4, DirectTwiddles).Transform(make([]complex128, 2), false) }} {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("invalid plan input did not panic")
				}
			}()
			operation()
		}()
	}
}
func BenchmarkPreparedTransform(b *testing.B) {
	for _, size := range []int{2048, 16384, 65536} {
		for _, strategy := range []TwiddleStrategy{DirectTwiddles, RecursiveTwiddles} {
			for _, legacy := range []bool{false, true} {
				b.Run(fmt.Sprintf("size%d/strategy%d/legacy%v", size, strategy, legacy), func(b *testing.B) {
					source := testSignal(size)
					values := make([]complex128, size)
					plan := New(size, strategy)
					old := newLegacyDirectPlan(size)
					b.ReportAllocs()
					b.ResetTimer()
					for b.Loop() {
						copy(values, source)
						if legacy {
							if strategy == DirectTwiddles {
								old.run(values, false)
							} else {
								legacyRecursive(values, false)
							}
						} else {
							plan.Transform(values, false)
						}
					}
				})
			}
		}
	}
}

func BenchmarkPlanPreparation(b *testing.B) {
	for _, size := range []int{2048, 16384, 65536} {
		for _, strategy := range []TwiddleStrategy{DirectTwiddles, RecursiveTwiddles} {
			b.Run(fmt.Sprintf("size%d/strategy%d", size, strategy), func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					plan := New(size, strategy)
					b.ReportMetric(float64(len(plan.forward)+len(plan.inverse))*16, "roots-B")
				}
			})
		}
	}
}
