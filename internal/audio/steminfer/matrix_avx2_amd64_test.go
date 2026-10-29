//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

package steminfer

// cspell:words noasm AVX2 FMA

import (
	"math"
	"testing"
)

func TestPackedMatrixLayoutsAndEdges(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	for _, shape := range [][3]int{{1, 1, 1}, {3, 17, 129}, {4, 16, 1}, {7, 31, 127}, {8, 33, 257}, {128, 65, 257}} {
		for _, transpose := range []bool{false, true} {
			rows, columns, inner := shape[0], shape[1], shape[2]
			left, right := make([]float32, rows*inner), make([]float32, columns*inner)
			storage := make([]float32, rows*columns+2)
			storage[0], storage[len(storage)-1] = 123, 456
			out := storage[1 : len(storage)-1]
			for i := range left {
				left[i] = float32(math.Sin(float64(i) * .73))
			}
			for i := range right {
				right[i] = float32(math.Cos(float64(i) * .37))
			}
			for i := range out {
				out[i] = float32(math.NaN())
			}
			multiplyPacked(out, left, right, rows, columns, inner, transpose)
			if storage[0] != 123 || storage[len(storage)-1] != 456 {
				t.Fatal("matrix wrote outside output")
			}
			for row := range rows {
				for column := range columns {
					var want, magnitude float64
					for k := range inner {
						offset := k*columns + column
						if transpose {
							offset = column*inner + k
						}
						product := float64(left[row*inner+k]) * float64(right[offset])
						want += product
						magnitude += math.Abs(product)
					}
					// Standard float32 accumulation bound; the independent model oracle
					// separately enforces the unchanged 1e-4 / 80 dB end-to-end gate.
					bound := math.Min(2e-7*float64(inner)*math.Max(1, magnitude), 2e-5*math.Max(1, math.Abs(want)))
					if delta := math.Abs(float64(out[row*columns+column]) - want); math.IsNaN(delta) || delta > bound {
						t.Fatalf("shape%v transposed%v row%d column%d delta%g bound%g", shape, transpose, row, column, delta, bound)
					}
				}
			}
		}
	}
}
func TestPackedMatrixHasNoWorkerOrScratchAllocations(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	const rows, columns, inner = 11, 33, 257
	left, right, out := make([]float32, rows*inner), make([]float32, columns*inner), make([]float32, rows*columns)
	if allocations := testing.AllocsPerRun(3, func() { multiplyPacked(out, left, right, rows, columns, inner, true) }); allocations != 0 {
		t.Fatalf("packed matrix allocated %g times", allocations)
	}
}

// Row grouping must not choose a different accumulation order for an edge.
// Compare the same rows alone, in short groups and in one matrix; no model
// weights or transformer behavior can hide a kernel difference here.
func TestPackedMatrixRowBatchInvariance(t *testing.T) {
	if !hasPackedMatrix() {
		t.Skip("AVX2/FMA unavailable")
	}
	const rows = 39
	for _, columns := range []int{8, 16, 31, 62, 257} {
		for _, inner := range []int{7, 64, 129} {
			for _, transpose := range []bool{false, true} {
				left, right := make([]float32, rows*inner), make([]float32, columns*inner)
				for i := range left {
					left[i] = float32(math.Sin(float64(i) * .73))
				}
				for i := range right {
					right[i] = float32(math.Cos(float64(i) * .37))
				}
				all, grouped := make([]float32, rows*columns), make([]float32, rows*columns)
				multiplyPacked(all, left, right, rows, columns, inner, transpose)
				for _, groupSize := range []int{1, 2, 3, 4, 13} {
					for first := 0; first < rows; first += groupSize {
						count := min(groupSize, rows-first)
						multiplyPacked(grouped[first*columns:(first+count)*columns], left[first*inner:(first+count)*inner], right, count, columns, inner, transpose)
					}
					for i, want := range all {
						if math.Float32bits(grouped[i]) != math.Float32bits(want) {
							t.Fatalf("columns%d inner%d transpose%v group%d index%d got%g want%g", columns, inner, transpose, groupSize, i, grouped[i], want)
						}
					}
				}
			}
		}
	}
}
