// Copyright 2026 Aurialis contributors.
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

package frame

import "math"

// dctScale[N/2 + n] = 1 / (2 cos(pi (2n+1) / (2N))) for the recursive
// Lee DCT-II stages of size N = 32, 16, 8, 4, 2.
var dctScale = func() (t [64]float32) {
	for n := 2; n <= 32; n <<= 1 {
		for i := 0; i < n/2; i++ {
			t[n/2+i] = float32(1 / (2 * math.Cos(math.Pi*float64(2*i+1)/float64(2*n))))
		}
	}
	return t
}()

// dctII computes the unnormalized DCT-II
// out[k] = sum x[n] cos(pi (2n+1) k / 2N) with Lee's recursive factorization.
// x is overwritten. len(x) must be a power of two; tmp needs len(x) space.
func dctII(x, out, tmp []float32) {
	n := len(x)
	if n == 1 {
		out[0] = x[0]
		return
	}
	half := n / 2
	a, b := tmp[:half], tmp[half:n]
	for i := 0; i < half; i++ {
		lo, hi := x[i], x[n-1-i]
		a[i] = lo + hi
		b[i] = (lo - hi) * dctScale[half+i]
	}
	even, odd := x[:half], x[half:n]
	dctII(a, even, out[:half])
	dctII(b, odd, out[half:n])
	for k := 0; k < half-1; k++ {
		out[2*k] = even[k]
		out[2*k+1] = odd[k] + odd[k+1]
	}
	out[n-2] = even[half-1]
	out[n-1] = odd[half-1]
}
