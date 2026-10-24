// Copyright 2017 Hajime Hoshi
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package imdct

import (
	"math"
)

var imdctWinData = [4][36]float32{}

func init() {
	for i := 0; i < 36; i++ {
		imdctWinData[0][i] = float32(math.Sin(math.Pi / 36 * (float64(i) + 0.5)))
	}
	for i := 0; i < 18; i++ {
		imdctWinData[1][i] = float32(math.Sin(math.Pi / 36 * (float64(i) + 0.5)))
	}
	for i := 18; i < 24; i++ {
		imdctWinData[1][i] = 1.0
	}
	for i := 24; i < 30; i++ {
		imdctWinData[1][i] = float32(math.Sin(math.Pi / 12 * (float64(i) + 0.5 - 18.0)))
	}
	for i := 30; i < 36; i++ {
		imdctWinData[1][i] = 0.0
	}
	for i := 0; i < 12; i++ {
		imdctWinData[2][i] = float32(math.Sin(math.Pi / 12 * (float64(i) + 0.5)))
	}
	for i := 12; i < 36; i++ {
		imdctWinData[2][i] = 0.0
	}
	for i := 0; i < 6; i++ {
		imdctWinData[3][i] = 0.0
	}
	for i := 6; i < 12; i++ {
		imdctWinData[3][i] = float32(math.Sin(math.Pi / 12 * (float64(i) + 0.5 - 6.0)))
	}
	for i := 12; i < 18; i++ {
		imdctWinData[3][i] = 1.0
	}
	for i := 18; i < 36; i++ {
		imdctWinData[3][i] = float32(math.Sin(math.Pi / 36 * (float64(i) + 0.5)))
	}
}

var cosN12 = [6][12]float32{}

func init() {
	const N = 12
	for i := 0; i < 6; i++ {
		for j := 0; j < 12; j++ {
			cosN12[i][j] = float32(math.Cos(math.Pi / (2 * N) * (2*float64(j) + 1 + N/2) * (2*float64(i) + 1)))
		}
	}
}

var cosN36 = [18][36]float32{}

func init() {
	const N = 36
	for i := 0; i < 18; i++ {
		for j := 0; j < 36; j++ {
			cosN36[i][j] = float32(math.Cos(math.Pi / (2 * N) * (2*float64(j) + 1 + N/2) * (2*float64(i) + 1)))
		}
	}
}

// Win writes the windowed IMDCT of 18 subband lines into out, which must be
// zeroed (Aurialis modification: caller-owned output instead of allocation).
func Win(in []float32, blockType int, out *[36]float32) {
	if blockType == 2 {
		iwd := imdctWinData[blockType]
		const N = 12
		for i := 0; i < 3; i++ {
			for p := 0; p < N; p++ {
				sum := float32(0.0)
				for m := 0; m < N/2; m++ {
					sum += in[i+3*m] * cosN12[m][p]
				}
				out[6*i+p+6] += sum * iwd[p]
			}
		}
		return
	}
	const N = 36
	iwd := imdctWinData[blockType]
	// Aurialis modification: the 36-point IMDCT has x[17-p] = -x[p] and
	// x[35-p] = x[18+p], so only 18 outputs are computed, from a compact
	// table, skipping zero lines.
	var half [18]float32
	for m, x := range (*[18]float32)(in[:18]) {
		if x == 0 {
			continue
		}
		row := &cosN36Half[m]
		for k := range half {
			half[k] += x * row[k]
		}
	}
	var raw [N]float32
	for p := 0; p < 9; p++ {
		raw[p] = half[p]
		raw[17-p] = -half[p]
		raw[18+p] = half[9+p]
		raw[35-p] = half[9+p]
	}
	for p := range raw {
		out[p] = raw[p] * iwd[p]
	}
}

// cosN36Half[m][k] holds cosN36[m][p] for p = 0..8 and 18..26. It is filled
// by init, after cosN36.
var cosN36Half [18][18]float32

func init() {
	for m := range cosN36Half {
		for k := 0; k < 9; k++ {
			cosN36Half[m][k] = cosN36[m][k]
			cosN36Half[m][9+k] = cosN36[m][18+k]
		}
	}
}
