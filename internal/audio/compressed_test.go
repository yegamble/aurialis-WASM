package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name)) // #nosec G304 -- fixed test fixture names
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func decodeFixture(t *testing.T, name string) *Buffer {
	t.Helper()
	buf, err := DecodeAndDisarm(name, readFixture(t, name))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return buf
}

func TestFLACDecodesBitExactToSourceWAV(t *testing.T) {
	for _, pair := range [][2]string{
		{"tone-44k-s16.flac", "tone-44k-s16.wav"},
		{"tone-96k-s24.flac", "tone-96k-s24.wav"},
		{"tone-48k-mono16.flac", "tone-48k-mono16.wav"},
	} {
		got, want := decodeFixture(t, pair[0]), decodeFixture(t, pair[1])
		if got.SampleRate != want.SampleRate || got.Frames != want.Frames {
			t.Fatalf("%s: geometry %d Hz/%d frames, want %d Hz/%d frames", pair[0], got.SampleRate, got.Frames, want.SampleRate, want.Frames)
		}
		for i := range want.Frames {
			if got.Left[i] != want.Left[i] || got.Right[i] != want.Right[i] {
				t.Fatalf("%s: frame %d = (%g, %g), want (%g, %g)", pair[0], i, got.Left[i], got.Right[i], want.Left[i], want.Right[i])
			}
		}
	}
}

// MP3 is lossy: require gapless length, sample alignment, and a sane SNR.
func TestMP3DecodesGaplessAndAligned(t *testing.T) {
	for _, tc := range []struct {
		mp3, wav string
		minSNR   float64
	}{
		{"tone-44k-cbr.mp3", "tone-44k-s16.wav", 30},
		{"tone-44k-vbr.mp3", "tone-44k-s16.wav", 30},
		{"tone-22k-mono.mp3", "", 0},
	} {
		got := decodeFixture(t, tc.mp3)
		if tc.wav == "" {
			if got.SampleRate != 22050 || math.Abs(got.Duration-0.2) > 0.001 {
				t.Fatalf("%s: %d Hz %.4fs, want 22050 Hz 0.2s", tc.mp3, got.SampleRate, got.Duration)
			}
			for i := range got.Frames {
				if got.Left[i] != got.Right[i] {
					t.Fatalf("%s: mono not duplicated at %d", tc.mp3, i)
				}
			}
			continue
		}
		want := decodeFixture(t, tc.wav)
		if got.SampleRate != want.SampleRate || got.Frames != want.Frames {
			t.Fatalf("%s: geometry %d Hz/%d frames, want %d Hz/%d frames", tc.mp3, got.SampleRate, got.Frames, want.SampleRate, want.Frames)
		}
		var signal, noise float64
		for i := range want.Frames {
			for _, d := range [][2]float32{{want.Left[i], got.Left[i]}, {want.Right[i], got.Right[i]}} {
				signal += float64(d[0]) * float64(d[0])
				e := float64(d[0] - d[1])
				noise += e * e
			}
		}
		if snr := 10 * math.Log10(signal/noise); snr < tc.minSNR {
			t.Fatalf("%s: SNR %.1f dB, want >= %.0f dB", tc.mp3, snr, tc.minSNR)
		}
	}
}

// hot-44k.mp3 is a 0 dBFS square wave coded with short blocks and M/S stereo.
// Upstream go-mp3 clipped it at 16-bit full scale and skipped M/S decoding past
// Count1 after short-block reordering; both must stay fixed.
func TestMP3HotShortBlocksMatchOracle(t *testing.T) {
	got := decodeFixture(t, "hot-44k.mp3")
	oracle := readFixture(t, "hot-44k.ffmpeg-f32le")
	if len(oracle)/8 != got.Frames {
		t.Fatalf("frames = %d, oracle %d", got.Frames, len(oracle)/8)
	}
	var peak float64
	for i := range got.Frames {
		l := math.Float32frombits(binary.LittleEndian.Uint32(oracle[i*8:]))
		r := math.Float32frombits(binary.LittleEndian.Uint32(oracle[i*8+4:]))
		if math.Abs(float64(l-got.Left[i])) > 1e-5 || math.Abs(float64(r-got.Right[i])) > 1e-5 {
			t.Fatalf("frame %d = (%g, %g), oracle (%g, %g)", i, got.Left[i], got.Right[i], l, r)
		}
		peak = math.Max(peak, math.Abs(float64(got.Left[i])))
	}
	if peak <= 1 {
		t.Fatalf("peak %g: decoded overs were clipped", peak)
	}
}

func TestCompressedContainersRejectPayloadsAndCorruption(t *testing.T) {
	flac := readFixture(t, "tone-44k-s16.flac")
	mp3 := readFixture(t, "tone-44k-cbr.mp3")
	id3 := func(body string) []byte {
		size := len(body)
		return append([]byte{'I', 'D', '3', 3, 0, 0, byte(size >> 21 & 0x7f), byte(size >> 14 & 0x7f), byte(size >> 7 & 0x7f), byte(size & 0x7f)}, body...)
	}
	cases := map[string]struct {
		name string
		raw  []byte
		want error
	}{
		"flac zip trailer":   {"a.flac", append(bytes.Clone(flac), append([]byte("PK\x03\x04"), make([]byte, 100)...)...), ErrPolyglotPayload},
		"flac junk trailer":  {"a.flac", append(bytes.Clone(flac), make([]byte, 200)...), ErrPolyglotPayload},
		"flac script tag":    {"a.flac", append(id3("<script>alert(1)</script>"), flac...), ErrPolyglotPayload},
		"flac flipped audio": {"a.flac", flipByte(flac, len(flac)/2), ErrCorruptContainer},
		"flac truncated":     {"a.flac", flac[:len(flac)*3/4], ErrCorruptContainer},
		"mp3 elf trailer":    {"a.mp3", append(bytes.Clone(mp3), append([]byte("\x7fELF"), make([]byte, 100)...)...), ErrPolyglotPayload},
		"mp3 html id3":       {"a.mp3", append(id3("<!DOCTYPE html><html>"), mp3...), ErrPolyglotPayload},
		"mp3 bad id3 size":   {"a.mp3", append([]byte{'I', 'D', '3', 3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f}, mp3...), ErrCorruptContainer},
		"lone frame sync":    {"a.mp3", append([]byte{0xFF, 0xFB, 0x90, 0x64}, make([]byte, 64)...), ErrCorruptContainer},
		"flac surround":      {"a.flac", surroundFLAC(flac), ErrCorruptContainer},
		"flac marker only":   {"a.flac", append([]byte("fLaC"), make([]byte, 60)...), ErrCorruptContainer},
	}
	for label, tc := range cases {
		if _, err := DecodeAndDisarm(tc.name, tc.raw); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", label, err, tc.want)
		}
	}
}

func TestCompressedAcceptsTagsAndTrailers(t *testing.T) {
	flac := readFixture(t, "tone-44k-s16.flac")
	tag := append([]byte("TAG"), make([]byte, 125)...)
	if _, err := DecodeAndDisarm("a.flac", append(bytes.Clone(flac), tag...)); err != nil {
		t.Fatalf("ID3v1 trailer: %v", err)
	}
	// tone-44k-vbr.mp3 carries both ID3v2 and ID3v1 tags.
	decodeFixture(t, "tone-44k-vbr.mp3")
}

// surroundFLAC rewrites the STREAMINFO channel field to six channels.
func surroundFLAC(raw []byte) []byte {
	out := bytes.Clone(raw)
	// STREAMINFO starts at 8; channels-1 occupies bits 1..3 of its byte 12.
	out[8+12] = out[8+12]&^0x0E | 5<<1
	return out
}

func flipByte(raw []byte, at int) []byte {
	out := bytes.Clone(raw)
	out[at] ^= 0x5A
	return out
}

func FuzzCompressedDecode(f *testing.F) {
	for _, name := range []string{"tone-44k-s16.flac", "tone-44k-cbr.mp3", "tone-22k-mono.mp3"} {
		raw, err := os.ReadFile(filepath.Join("testdata", name)) // #nosec G304 -- fixed test fixture names
		if err != nil {
			f.Fatal(err)
		}
		f.Add(raw[:min(len(raw), 4096)])
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		for _, name := range []string{"f.flac", "f.mp3"} {
			buf, err := DecodeAndDisarm(name, raw)
			if err == nil && (buf.Frames != len(buf.Left) || buf.Frames > MaxDecodedFrames) {
				t.Fatalf("inconsistent buffer %d/%d", buf.Frames, len(buf.Left))
			}
		}
	})
}
