package dsp

import (
	"math"
	"testing"
)

func TestADAAHelpersMatchPreChangeGoldenBits(t *testing.T) {
	// Captured from the original combined helper before splitting lazy evaluation.
	// Includes signed zero, tiny differences, the magnitude20 branch boundary,
	// infinities, NaN, and extreme finite values at three distinct drives.
	golden := []struct{ x, drive, value, integral uint64 }{
		{0xfff0000000000000, 0x3ff0000000000000, 0xbff0000000000000, 0x7ff0000000000000},
		{0xffefffffffffffff, 0x3ff0000000000000, 0xbff0000000000000, 0x7fefffffffffffff},
		{0xc034000000000000, 0x3ff0000000000000, 0xbff0000000000000, 0x40334e8de8082e31},
		{0xc034000000000001, 0x3ff0000000000000, 0xbff0000000000000, 0x40334e8de8082e32},
		{0xbeb0c6f7a0b5ed8d, 0x3ff0000000000000, 0xbeb0c6f7a0b5e767, 0x3d61980000000000},
		{0xbeb0c6f7a0b5ed8c, 0x3ff0000000000000, 0xbeb0c6f7a0b5e766, 0x3d61980000000000},
		{0x8000000000000000, 0x3ff0000000000000, 0x8000000000000000, 0x0},
		{0x0, 0x3ff0000000000000, 0x0, 0x0},
		{0x1, 0x3ff0000000000000, 0x1, 0x0},
		{0x3eb0c6f7a0b5ed8d, 0x3ff0000000000000, 0x3eb0c6f7a0b5e767, 0x3d61980000000000},
		{0x3eb0c6f7a0b5ed8e, 0x3ff0000000000000, 0x3eb0c6f7a0b5e768, 0x3d61980000000000},
		{0x4034000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x40334e8de8082e31},
		{0x4034000000000001, 0x3ff0000000000000, 0x3ff0000000000000, 0x40334e8de8082e32},
		{0x7fefffffffffffff, 0x3ff0000000000000, 0x3ff0000000000000, 0x7fefffffffffffff},
		{0x7ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x7ff0000000000000},
		{0x7ff8000000000001, 0x3ff0000000000000, 0x7ff8000000000001, 0x7ff8000000000001},
		{0xfff0000000000000, 0x3ff199999999999a, 0xbff0000000000000, 0x7ff0000000000000},
		{0xffefffffffffffff, 0x3ff199999999999a, 0xbff0000000000000, 0x7ff0000000000000},
		{0xc0322e8ba2e8ba2e, 0x3ff199999999999a, 0xbff0000000000000, 0x40318d3b30076fcf},
		{0xc0322e8ba2e8ba2f, 0x3ff199999999999a, 0xbff0000000000000, 0x40318d3b30076fd0},
		{0xbeb0c6f7a0b5ed8d, 0x3ff199999999999a, 0xbeb27476ca61b053, 0x3d6359a2e8ba2e8b},
		{0xbeb0c6f7a0b5ed8c, 0x3ff199999999999a, 0xbeb27476ca61b052, 0x3d6359a2e8ba2e8b},
		{0x8000000000000000, 0x3ff199999999999a, 0x8000000000000000, 0x0},
		{0x0, 0x3ff199999999999a, 0x0, 0x0},
		{0x1, 0x3ff199999999999a, 0x1, 0x0},
		{0x3eb0c6f7a0b5ed8d, 0x3ff199999999999a, 0x3eb27476ca61b053, 0x3d6359a2e8ba2e8b},
		{0x3eb0c6f7a0b5ed8e, 0x3ff199999999999a, 0x3eb27476ca61b054, 0x3d6359a2e8ba2e8b},
		{0x40322e8ba2e8ba2e, 0x3ff199999999999a, 0x3ff0000000000000, 0x40318d3b30076fcf},
		{0x40322e8ba2e8ba2f, 0x3ff199999999999a, 0x3ff0000000000000, 0x40318d3b30076fd0},
		{0x7fefffffffffffff, 0x3ff199999999999a, 0x3ff0000000000000, 0x7ff0000000000000},
		{0x7ff0000000000000, 0x3ff199999999999a, 0x3ff0000000000000, 0x7ff0000000000000},
		{0x7ff8000000000001, 0x3ff199999999999a, 0x7ff8000000000001, 0x7ff8000000000001},
		{0xfff0000000000000, 0x4010cccccccccccd, 0xbff0000000000000, 0x7ff0000000000000},
		{0xffefffffffffffff, 0x4010cccccccccccd, 0xbff0000000000000, 0x7ff0000000000000},
		{0xc0130c30c30c30c3, 0x4010cccccccccccd, 0xbff0000000000000, 0x40126331d0cad6a8},
		{0xc0130c30c30c30c4, 0x4010cccccccccccd, 0xbff0000000000000, 0x40126331d0cad6a9},
		{0xbeb0c6f7a0b5ed8d, 0x4010cccccccccccd, 0xbed19db7358b6123, 0x3d8278cf3cf3cf3d},
		{0xbeb0c6f7a0b5ed8c, 0x4010cccccccccccd, 0xbed19db7358b6122, 0x3d8278cf3cf3cf3d},
		{0x8000000000000000, 0x4010cccccccccccd, 0x8000000000000000, 0x0},
		{0x0, 0x4010cccccccccccd, 0x0, 0x0},
		{0x1, 0x4010cccccccccccd, 0x4, 0x0},
		{0x3eb0c6f7a0b5ed8d, 0x4010cccccccccccd, 0x3ed19db7358b6123, 0x3d8278cf3cf3cf3d},
		{0x3eb0c6f7a0b5ed8e, 0x4010cccccccccccd, 0x3ed19db7358b6125, 0x3d8278cf3cf3cf3d},
		{0x40130c30c30c30c3, 0x4010cccccccccccd, 0x3ff0000000000000, 0x40126331d0cad6a8},
		{0x40130c30c30c30c4, 0x4010cccccccccccd, 0x3ff0000000000000, 0x40126331d0cad6a9},
		{0x7fefffffffffffff, 0x4010cccccccccccd, 0x3ff0000000000000, 0x7ff0000000000000},
		{0x7ff0000000000000, 0x4010cccccccccccd, 0x3ff0000000000000, 0x7ff0000000000000},
		{0x7ff8000000000001, 0x4010cccccccccccd, 0x7ff8000000000001, 0x7ff8000000000001},
	}
	for index, row := range golden {
		x, drive := math.Float64frombits(row.x), math.Float64frombits(row.drive)
		for name, pair := range map[string][2]float64{
			"value":    {adaaThickValue(x, drive), math.Float64frombits(row.value)},
			"integral": {adaaThickIntegral(x, drive), math.Float64frombits(row.integral)},
		} {
			actual, expected := pair[0], pair[1]
			if math.IsNaN(expected) {
				if !math.IsNaN(actual) {
					t.Fatalf("case %d %s lost NaN", index, name)
				}
			} else if math.Float64bits(actual) != math.Float64bits(expected) {
				t.Fatalf("case %d %s changed: got %x want %x", index, name, math.Float64bits(actual), math.Float64bits(expected))
			}
		}
	}
}
