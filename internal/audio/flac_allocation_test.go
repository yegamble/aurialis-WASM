package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"runtime"
	"testing"
)

// STREAMINFO's sample count is a bound, not proof that PCM exists.
func TestFLACTruncatedDeclarationBoundsAllocation(t *testing.T) {
	raw := bytes.Clone(readFixture(t, "tone-44k-s16.flac")[:42])
	raw[4] = 0x80 // STREAMINFO is the last metadata block.
	setFLACTotalSamples(raw, MaxDecodedFrames)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, err := decodeAndDisarmFLAC(raw)
	runtime.ReadMemStats(&after)
	if !errors.Is(err, ErrCorruptContainer) {
		t.Fatalf("metadata-only stream: %v, want corrupt container", err)
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("metadata-only maximum declaration allocated %d bytes", allocated)
	if allocated > 1<<20 {
		t.Fatalf("metadata-only stream allocated %d bytes, want at most 1 MiB", allocated)
	}
}

func setFLACTotalSamples(raw []byte, total uint64) {
	field := binary.BigEndian.Uint64(raw[18:26])
	binary.BigEndian.PutUint64(raw[18:26], field & ^uint64((1<<36)-1) | total)
}

func TestFLACKnownAndUnknownLengthMatch(t *testing.T) {
	for _, name := range []string{"tone-44k-s16.flac", "tone-96k-s24.flac", "tone-48k-mono16.flac"} {
		t.Run(name, func(t *testing.T) {
			raw := readFixture(t, name)
			want, err := decodeAndDisarmFLAC(raw)
			if err != nil {
				t.Fatal(err)
			}
			setFLACTotalSamples(raw, 0)
			got, err := decodeAndDisarmFLAC(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got.SampleRate != want.SampleRate || got.Channels != want.Channels || got.Frames != want.Frames || got.Duration != want.Duration {
				t.Fatal("unknown length changed audio geometry")
			}
			for i := range want.Frames {
				if got.Left[i] != want.Left[i] || got.Right[i] != want.Right[i] {
					t.Fatalf("PCM changed at frame %d", i)
				}
			}
		})
	}
}

// A ten-second stereo stream with constant subframe encoding keeps benchmark setup
// independent of external encoders and large checked-in fixtures.
func BenchmarkFLACValidatedBlockGrowth(b *testing.B) {
	const blocks = 108
	const blockSize = 4096
	raw := make([]byte, 42)
	copy(raw, "fLaC")
	raw[4], raw[7] = 0x80, 34
	binary.BigEndian.PutUint16(raw[8:10], blockSize)
	binary.BigEndian.PutUint16(raw[10:12], blockSize)
	binary.BigEndian.PutUint64(raw[18:26], uint64(44100)<<44|uint64(1)<<41|uint64(15)<<36|blocks*blockSize)
	for number := range blocks {
		frame := []byte{0xff, 0xf8, 0xc9, 0x18, byte(number)}
		frame = append(frame, flacCRC8(frame))
		frame = append(frame, 0, 0x20, 0, 0, 0xe0, 0) // L=8192, R=-8192.
		frame = binary.BigEndian.AppendUint16(frame, flacCRC16(frame))
		raw = append(raw, frame...)
	}
	b.ReportAllocs()
	b.SetBytes(blocks * blockSize * 8)
	b.ResetTimer()
	for b.Loop() {
		buf, err := decodeAndDisarmFLAC(raw)
		if err != nil {
			b.Fatal(err)
		}
		if buf.Frames != blocks*blockSize || buf.Left[buf.Frames-1] != .25 || buf.Right[buf.Frames-1] != -.25 {
			b.Fatal("incorrect constant PCM")
		}
		b.ReportMetric(float64(cap(buf.Left)+cap(buf.Right))*4, "PCM-cap-B")
	}
}

func TestFLACLengthAndMD5ValidationRemainEnforced(t *testing.T) {
	original := readFixture(t, "tone-44k-s16.flac")
	total := binary.BigEndian.Uint64(original[18:26]) & ((1 << 36) - 1)
	for _, tc := range []struct {
		name   string
		total  uint64
		badMD5 bool
	}{
		{"declared limit", MaxDecodedFrames + 1, false},
		{"block exceeds declaration", 1, false},
		{"truncated declaration", total + 1, false},
		{"known length MD5", total, true},
		{"unknown length MD5", 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := bytes.Clone(original)
			setFLACTotalSamples(raw, tc.total)
			if tc.badMD5 {
				raw[26] ^= 1
			}
			if _, err := decodeAndDisarmFLAC(raw); !errors.Is(err, ErrCorruptContainer) {
				t.Fatalf("invalid stream: %v, want corrupt container", err)
			}
		})
	}
}
