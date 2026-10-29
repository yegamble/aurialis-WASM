package audio

import (
	"encoding/binary"
	"errors"
	"testing"
)

type flacTestBits struct {
	data  []byte
	count uint
}

func (b *flacTestBits) put(value int64, width uint) {
	for i := width; i > 0; i-- {
		if b.count%8 == 0 {
			b.data = append(b.data, 0)
		}
		b.data[len(b.data)-1] |= byte((uint64(value)>>(i-1))&1) << (7 - b.count%8)
		b.count++
	}
}
func flacConstantFrame(assignment byte, values [2]int64) []byte {
	raw := make([]byte, 42)
	copy(raw, "fLaC")
	raw[4], raw[7] = 0x80, 34
	binary.BigEndian.PutUint16(raw[8:10], 16)
	binary.BigEndian.PutUint16(raw[10:12], 16)
	binary.BigEndian.PutUint64(raw[18:26], uint64(44100)<<44|uint64(1)<<41|uint64(15)<<36|16)
	frame := []byte{0xff, 0xf8, 0x69, assignment<<4 | 8, 0, 15}
	frame = append(frame, flacCRC8(frame))
	var bits flacTestBits
	for ch, value := range values {
		width := uint(16)
		if (assignment == 8 && ch == 1) || (assignment == 9 && ch == 0) || (assignment == 10 && ch == 1) {
			width++
		}
		bits.put(0, 8)
		bits.put(value, width)
	}
	frame = append(frame, bits.data...)
	frame = binary.BigEndian.AppendUint16(frame, flacCRC16(frame))
	return append(raw, frame...)
}
func TestFLACRejectsOutOfRangeStereoReconstruction(t *testing.T) {
	for _, tc := range []struct {
		name       string
		assignment byte
		values     [2]int64
	}{
		{"left side positive", 8, [2]int64{32767, -65536}}, {"left side negative", 8, [2]int64{-32768, 65535}},
		{"side right positive", 9, [2]int64{65535, 32767}}, {"side right negative", 9, [2]int64{-65536, -32768}},
		{"mid side positive", 10, [2]int64{32767, 65535}}, {"mid side negative", 10, [2]int64{-32768, -65536}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeAndDisarmFLAC(flacConstantFrame(tc.assignment, tc.values)); !errors.Is(err, ErrCorruptContainer) {
				t.Fatalf("invalid sample accepted: %v", err)
			}
		})
	}
}
func TestFLACStereoRangeBoundariesRemainExact(t *testing.T) {
	for _, assignment := range []byte{1, 8, 9, 10} {
		for _, pair := range [][2]int64{{-32768, 32767}, {32767, -32768}, {-32768, -32768}, {32767, 32767}} {
			values := pair
			switch assignment {
			case 8:
				values = [2]int64{pair[0], pair[0] - pair[1]}
			case 9:
				values = [2]int64{pair[0] - pair[1], pair[1]}
			case 10:
				values = [2]int64{(pair[0] + pair[1]) >> 1, pair[0] - pair[1]}
			}
			buf, err := decodeAndDisarmFLAC(flacConstantFrame(assignment, values))
			if err != nil {
				t.Fatal(err)
			}
			if buf.Left[0] != float32(pair[0])/32768 || buf.Right[0] != float32(pair[1])/32768 {
				t.Fatalf("assignment %d changed boundary samples", assignment)
			}
		}
	}
}
func TestFLACPredictorsRejectRangeOverflow(t *testing.T) {
	for _, sign := range []int64{-1, 1} {
		for order := 1; order <= 4; order++ {
			var bits flacTestBits
			warm := int64(32767)
			if sign < 0 {
				warm = -32768
			}
			for range order {
				bits.put(warm, 16)
			}
			// Rice escape, one partition, signed two-bit residuals.
			bits.put(0, 2)
			bits.put(0, 4)
			bits.put(15, 4)
			bits.put(2, 5)
			bits.put(sign, 2)
			out := make([]int64, order+1)
			r := flacBits{data: bits.data}
			if err := decodeFLACFixed(&r, 16, order, out); err == nil {
				t.Fatalf("fixed order %d accepted overflow", order)
			}
		}
		var bits flacTestBits
		warm := int64(32767)
		if sign < 0 {
			warm = -32768
		}
		bits.put(warm, 16)
		bits.put(1, 4)
		bits.put(0, 5)
		bits.put(1, 2) // two-bit coefficient +1, shift zero.
		bits.put(0, 2)
		bits.put(0, 4)
		bits.put(15, 4)
		bits.put(2, 5)
		bits.put(sign, 2)
		out := make([]int64, 2)
		r := flacBits{data: bits.data}
		if err := decodeFLACLPC(&r, 16, 1, out); err == nil {
			t.Fatal("LPC accepted overflow")
		}
	}
}
