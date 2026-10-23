//go:build ignore

// This development-only exporter uses independent Float64 and rounded Float32 dots.
// It never loads a model or audio. Run explicitly with a fresh output directory.
package main

// cspell:words AUGEMM

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

type fixture struct {
	Name   string `json:"name"`
	M      int    `json:"m"`
	N      int    `json:"n"`
	K      int    `json:"k"`
	Kind   string `json:"kind"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func values(count int, kind string, side int) []float32 {
	result := make([]float32, count)
	for i := range result {
		value := float32((i*(side*6+1))%19-9) / 32
		switch kind {
		case "zero":
			value = 0
		case "large":
			value *= 1e10
		case "small-normal":
			value *= 1e-15
		case "subnormal-input":
			value = 1e-40
			if side == 1 {
				value = 1e30
			}
		case "subnormal-product":
			value = 1e-20
		case "cancellation":
			value = 1
			if side == 0 {
				value = 1e5
				if i%2 == 1 {
					value = -1e5
				}
				if i == count-1 {
					value = 0.001
				}
			}
		}
		result[i] = value
	}
	if kind == "tail" {
		result[count-1] = 0.75
		if side == 1 {
			result[count-1] = -0.5
		}
	}
	return result
}

func compensatedAdd(sum, correction, value float64) (float64, float64) {
	adjusted := value - correction
	next := sum + adjusted
	return next, (next - sum) - adjusted
}

func encode(m, n, k int, kind string) []byte {
	a, b := values(m*k, kind, 0), values(n*k, kind, 1)
	data := append([]byte{}, "AUGEMM01"...)
	for _, dimension := range []int{m, n, k, 0} {
		data = binary.LittleEndian.AppendUint32(data, uint32(dimension)) // dimensions are fixed <=65 below
	}
	for _, input := range [][]float32{a, b} {
		for _, value := range input {
			data = binary.LittleEndian.AppendUint32(data, math.Float32bits(value))
		}
	}
	expected, absolute, rounded := make([]float64, m*n), make([]float64, m*n), make([]float32, m*n)
	for row := range m {
		for column := range n {
			var sum, correction, absSum, absCorrection float64
			var f32 float32
			for index := range k {
				av, bv := a[row*k+index], b[column*k+index]
				product := float64(av) * float64(bv)
				sum, correction = compensatedAdd(sum, correction, product)
				absSum, absCorrection = compensatedAdd(absSum, absCorrection, math.Abs(product))
				// Explicit conversions prevent a fused multiply-add diagnostic.
				f32 = float32(f32 + float32(av*bv))
			}
			position := row*n + column
			expected[position], absolute[position], rounded[position] = sum, absSum, f32
		}
	}
	for _, output := range [][]float64{expected, absolute} {
		for _, value := range output {
			data = binary.LittleEndian.AppendUint64(data, math.Float64bits(value))
		}
	}
	for _, value := range rounded {
		data = binary.LittleEndian.AppendUint32(data, math.Float32bits(value))
	}
	return data
}

func run(directory string) error {
	if err := os.Mkdir(directory, 0o700); err != nil {
		return err
	}
	var entries []fixture
	write := func(m, n, k int, kind string) error {
		data := encode(m, n, k, kind)
		digest := sha256.Sum256(data)
		name := fmt.Sprintf("%s-m%d-n%d-k%d.bin", kind, m, n, k)
		// This path is a fresh developer-owned fixture directory, never request data.
		if err := os.WriteFile(filepath.Join(directory, name), data, 0o600); err != nil {
			return err
		}
		entries = append(entries, fixture{Name: name, M: m, N: n, K: k, Kind: kind, Bytes: len(data), SHA256: hex.EncodeToString(digest[:])})
		return nil
	}
	for _, m := range []int{1, 63, 64, 65} {
		for _, n := range []int{1, 63, 64, 65} {
			for _, k := range []int{1, 15, 16, 17} {
				if err := write(m, n, k, "tail"); err != nil {
					return err
				}
			}
		}
	}
	for _, kind := range []string{"zero", "large", "small-normal", "subnormal-input", "subnormal-product", "cancellation"} {
		if err := write(1, 1, 17, kind); err != nil {
			return err
		}
	}
	manifest, err := json.MarshalIndent(struct {
		Format string    `json:"format"`
		Cases  []fixture `json:"cases"`
	}{"aurialis-private-gemm-fixtures-1", entries}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(directory, "manifest.json"), append(manifest, '\n'), 0o600)
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run fixtures.go FRESH_OUTPUT_DIRECTORY")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
