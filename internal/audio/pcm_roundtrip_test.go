package audio

import (
	"math"
	"testing"
)

// Audit finding 14: decoding divided by 2^(bits-1) but encoding multiplied by
// 2^(bits-1)-1, shifting every sample above half scale by one LSB.
func TestIntegerWAVRoundTripIsBitExact(t *testing.T) {
	for _, bits := range []int{16, 24} {
		scale := math.Ldexp(1, bits-1)
		var left []float32
		for k := -scale; k < scale; k += math.Max(1, math.Floor(scale/4093)) {
			left = append(left, float32(k/scale))
		}
		left = append(left, float32((scale-1)/scale), -1)
		raw, err := EncodeWAV(left, left, 48000, bits)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeAndDisarm("x.wav", raw)
		if err != nil {
			t.Fatal(err)
		}
		for i, want := range left {
			if decoded.Left[i] != want {
				t.Fatalf("%d-bit sample %d: %v decoded as %v", bits, i, want, decoded.Left[i])
			}
		}
		hot := make([]float32, 16)
		hot[0], hot[1], hot[2] = 1, 1.5, -1.5
		clipped, err := EncodeWAV(hot, hot, 48000, bits)
		if err != nil {
			t.Fatal(err)
		}
		back, err := DecodeAndDisarm("x.wav", clipped)
		if err != nil {
			t.Fatal(err)
		}
		if float64(back.Left[0]) != (scale-1)/scale || float64(back.Left[1]) != (scale-1)/scale || back.Left[2] != -1 {
			t.Fatalf("%d-bit overs clip to %v / %v / %v", bits, back.Left[0], back.Left[1], back.Left[2])
		}
	}
}
