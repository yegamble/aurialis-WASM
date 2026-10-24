package audio

import (
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestCompressedMatchesFFmpegOracle encodes a matrix of FLAC and MP3 variants
// and compares Aurialis decoding to FFmpeg's float decoders. It is skipped when
// ffmpeg is not installed.
func TestCompressedMatchesFFmpegOracle(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	source := "aevalsrc='0.7*sin(2*PI*220*t)*sin(2*PI*3*t)+0.25*(random(0)-0.5)|0.9*sgn(sin(2*PI*110*t))*0.9+0.05*random(1)':d=0.6"
	cases := []struct {
		name    string
		args    []string
		decoder string
		tol     float64
	}{
		{"s16.flac", []string{"-ar", "44100", "-c:a", "flac"}, "flac", 0},
		{"s24.flac", []string{"-ar", "96000", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-c:a", "flac", "-compression_level", "12"}, "flac", 0},
		{"lpc32.flac", []string{"-ar", "48000", "-c:a", "flac", "-lpc_type", "cholesky", "-max_prediction_order", "32", "-compression_level", "12"}, "flac", 0},
		{"fixed.flac", []string{"-ar", "48000", "-c:a", "flac", "-lpc_type", "fixed"}, "flac", 0},
		{"small-blocks.flac", []string{"-ar", "32000", "-c:a", "flac", "-frame_size", "1152"}, "flac", 0},
		{"cbr320.mp3", []string{"-ar", "48000", "-c:a", "libmp3lame", "-b:a", "320k"}, "mp3float", 1e-5},
		{"cbr96-js.mp3", []string{"-ar", "44100", "-c:a", "libmp3lame", "-b:a", "96k"}, "mp3float", 1e-5},
		{"vbr.mp3", []string{"-ar", "32000", "-c:a", "libmp3lame", "-q:a", "6"}, "mp3float", 1e-5},
		{"mpeg2.mp3", []string{"-ar", "24000", "-c:a", "libmp3lame", "-b:a", "48k"}, "mp3float", 1e-5},
		{"mpeg2-16k.mp3", []string{"-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"}, "mp3float", 1e-5},
		{"dual-mono.mp3", []string{"-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", "-joint_stereo", "0"}, "mp3float", 1e-5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name)
			args := append([]string{"-loglevel", "error", "-f", "lavfi", "-i", source}, tc.args...)
			// #nosec G204 -- test-only oracle with fixed arguments
			if out, err := exec.CommandContext(t.Context(), ffmpeg, append(args, path)...).CombinedOutput(); err != nil {
				t.Fatalf("encode: %v %s", err, out)
			}
			raw, err := os.ReadFile(path) // #nosec G304 -- test temp file
			if err != nil {
				t.Fatal(err)
			}
			got, err := DecodeAndDisarm(tc.name, raw)
			if err != nil {
				t.Fatal(err)
			}
			// #nosec G204 -- test-only oracle with fixed arguments
			pcm, err := exec.CommandContext(t.Context(), ffmpeg, "-loglevel", "error", "-c:a", tc.decoder, "-i", path, "-af", "pan=stereo|c0=c0|c1=c1", "-f", "f32le", "-").Output()
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
			if worst > tc.tol {
				t.Fatalf("max sample difference %g > %g", worst, tc.tol)
			}
		})
	}
}
