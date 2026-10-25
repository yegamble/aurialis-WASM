package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestPCMLayoutsMatchFFmpegOracle covers the layouts DAWs commonly export:
// FFmpeg writes WAVE_FORMAT_EXTENSIBLE for >16-bit or >48 kHz WAV, and AIFF-C
// for float or little-endian AIFF. It is skipped when ffmpeg is not installed.
func TestPCMLayoutsMatchFFmpegOracle(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	source := "aevalsrc='0.7*sin(2*PI*220*t)*sin(2*PI*3*t)+0.25*(random(0)-0.5)|0.9*sin(2*PI*110*t)':d=0.3"
	cases := []struct {
		name string
		args []string
		tag  string // Layout marker the fixture must contain, proving the case.
	}{
		{"s24-48k-extensible.wav", []string{"-ar", "48000", "-c:a", "pcm_s24le"}, "\xfe\xff"},
		{"s16-96k-extensible.wav", []string{"-ar", "96000", "-c:a", "pcm_s16le"}, "\xfe\xff"},
		{"s32-44k-extensible.wav", []string{"-ar", "44100", "-c:a", "pcm_s32le"}, "\xfe\xff"},
		{"f32-192k-extensible.wav", []string{"-ar", "192000", "-c:a", "pcm_f32le"}, "\xfe\xff"},
		{"mono-s24-48k-extensible.wav", []string{"-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le"}, "\xfe\xff"},
		{"u8-22k.wav", []string{"-ar", "22050", "-c:a", "pcm_u8"}, ""},
		{"s24-48k.aiff", []string{"-ar", "48000", "-c:a", "pcm_s24be"}, ""},
		{"s32-96k.aiff", []string{"-ar", "96000", "-c:a", "pcm_s32be"}, ""},
		{"s8-32k.aif", []string{"-ar", "32000", "-c:a", "pcm_s8"}, ""},
		{"mono-s16-44k.aif", []string{"-ar", "44100", "-ac", "1", "-c:a", "pcm_s16be"}, ""},
		{"f32-48k.aifc", []string{"-ar", "48000", "-c:a", "pcm_f32be"}, "fl32"},
		{"sowt-44k.aifc", []string{"-ar", "44100", "-c:a", "pcm_s16le"}, "sowt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name)
			format := "wav"
			if ext := filepath.Ext(tc.name); ext != ".wav" {
				format = "aiff"
			}
			args := append([]string{"-loglevel", "error", "-f", "lavfi", "-i", source}, tc.args...)
			args = append(args, "-map_metadata", "-1", "-f", format, path)
			// #nosec G204 -- test-only oracle with fixed arguments
			if out, err := exec.CommandContext(t.Context(), ffmpeg, args...).CombinedOutput(); err != nil {
				t.Fatalf("encode: %v %s", err, out)
			}
			raw, err := os.ReadFile(path) // #nosec G304 -- test temp file
			if err != nil {
				t.Fatal(err)
			}
			if tc.tag != "" && !bytes.Contains(raw[:64], []byte(tc.tag)) {
				t.Fatalf("fixture lacks expected layout marker %q", tc.tag)
			}
			got, err := DecodeAndDisarm(tc.name, raw)
			if err != nil {
				t.Fatal(err)
			}
			pan := "pan=stereo|c0=c0|c1=c1"
			if bytes.Contains([]byte(tc.name), []byte("mono")) {
				pan = "pan=stereo|c0=c0|c1=c0" // Mono sources are duplicated to both channels.
			}
			// #nosec G204 -- test-only oracle with fixed arguments
			pcm, err := exec.CommandContext(t.Context(), ffmpeg, "-loglevel", "error", "-i", path, "-af", pan, "-f", "f32le", "-").Output()
			if err != nil {
				t.Fatal(err)
			}
			frames := len(pcm) / 8
			if frames != got.Frames {
				t.Fatalf("frames = %d, ffmpeg %d", got.Frames, frames)
			}
			var worst float64
			for i := range frames {
				l := math.Float32frombits(binary.LittleEndian.Uint32(pcm[i*8:]))
				r := math.Float32frombits(binary.LittleEndian.Uint32(pcm[i*8+4:]))
				worst = math.Max(worst, math.Max(math.Abs(float64(l-got.Left[i])), math.Abs(float64(r-got.Right[i]))))
			}
			if worst > 1e-7 {
				t.Fatalf("max sample difference %g", worst)
			}
		})
	}
}

func extensibleWAV(t *testing.T, bits, validBits uint16, code uint32, tail []byte, extension []byte) []byte {
	t.Helper()
	const channels, rate, frames = 2, 48000, 64
	width := int(bits / 8)
	fmtChunk := make([]byte, 40)
	binary.LittleEndian.PutUint16(fmtChunk[0:], 0xFFFE)
	binary.LittleEndian.PutUint16(fmtChunk[2:], channels)
	binary.LittleEndian.PutUint32(fmtChunk[4:], rate)
	binary.LittleEndian.PutUint32(fmtChunk[8:], uint32(rate*channels*width))
	binary.LittleEndian.PutUint16(fmtChunk[12:], uint16(channels*width))
	binary.LittleEndian.PutUint16(fmtChunk[14:], bits)
	binary.LittleEndian.PutUint16(fmtChunk[16:], 22)
	binary.LittleEndian.PutUint16(fmtChunk[18:], validBits)
	binary.LittleEndian.PutUint32(fmtChunk[20:], 3)
	binary.LittleEndian.PutUint32(fmtChunk[24:], code)
	copy(fmtChunk[28:], tail)
	if extension != nil {
		fmtChunk = extension
	}
	data := make([]byte, frames*channels*width)
	for i := 0; i < len(data); i += width {
		// A left-justified 20-bit value of +0.5 full scale in a 24-bit container.
		v := int32(1) << (bits - 2)
		for b := range width {
			data[i+b] = byte(v >> (8 * b))
		}
	}
	var out bytes.Buffer
	out.WriteString("RIFF")
	_ = binary.Write(&out, binary.LittleEndian, uint32(4+8+len(fmtChunk)+8+len(data)))
	out.WriteString("WAVEfmt ")
	_ = binary.Write(&out, binary.LittleEndian, uint32(len(fmtChunk)))
	out.Write(fmtChunk)
	out.WriteString("data")
	_ = binary.Write(&out, binary.LittleEndian, uint32(len(data)))
	out.Write(data)
	return out.Bytes()
}

func TestExtensibleWAVValidation(t *testing.T) {
	tail := []byte{0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}
	buf, err := DecodeAndDisarm("x.wav", extensibleWAV(t, 24, 20, 1, tail, nil))
	if err != nil || buf.Frames != 64 || buf.Left[0] != 0.5 || buf.Right[63] != 0.5 {
		t.Fatalf("20-in-24-bit extensible PCM: %v %+v", err, buf)
	}
	badTail := append([]byte(nil), tail...)
	badTail[11] = 0
	short := make([]byte, 18)
	binary.LittleEndian.PutUint16(short[0:], 0xFFFE)
	binary.LittleEndian.PutUint16(short[2:], 2)
	binary.LittleEndian.PutUint32(short[4:], 48000)
	binary.LittleEndian.PutUint32(short[8:], 48000*6)
	binary.LittleEndian.PutUint16(short[12:], 6)
	binary.LittleEndian.PutUint16(short[14:], 24)
	for name, raw := range map[string][]byte{
		"valid bits exceed container": extensibleWAV(t, 24, 25, 1, tail, nil),
		"zero valid bits":             extensibleWAV(t, 24, 0, 1, tail, nil),
		"unknown GUID":                extensibleWAV(t, 24, 24, 1, badTail, nil),
		"compressed sub-format":       extensibleWAV(t, 16, 16, 2, tail, nil),
		"float sub-format at 24 bits": extensibleWAV(t, 24, 24, 3, tail, nil),
		"truncated extension":         extensibleWAV(t, 24, 24, 1, tail, short),
	} {
		if _, err := DecodeAndDisarm("x.wav", raw); !errors.Is(err, ErrCorruptContainer) {
			t.Errorf("%s: err = %v, want ErrCorruptContainer", name, err)
		}
	}
}

func TestAIFFRejectsUnsupportedEncodings(t *testing.T) {
	for _, tc := range []struct {
		encoding string
		bits     uint16
	}{{"ulaw", 16}, {"sowt", 24}, {"fl32", 16}, {"NONE", 0}, {"NONE", 33}} {
		if _, _, err := aiffSampleDecoder(tc.encoding, tc.bits); !errors.Is(err, ErrCorruptContainer) {
			t.Errorf("%s/%d: err = %v", tc.encoding, tc.bits, err)
		}
	}
	decode, width, err := aiffSampleDecoder("NONE", 20)
	if err != nil || width != 3 || decode([]byte{0x80, 0x00, 0x00}) != -1 || decode([]byte{0x40, 0x00, 0x00}) != 0.5 {
		t.Fatalf("20-bit AIFF must decode left-justified in three bytes")
	}
}
