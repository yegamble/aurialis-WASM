package audio

import (
	"math"
	"testing"
)

// Fuzz inputs are capped independently of the production request bound. Output
// remains bounded by the production MaxDecodedFrames contract; run one fuzz
// worker so highly compressed inputs cannot multiply that working set.
const maxParserFuzzBytes = 64 * 1024

func checkFuzzDecoded(t *testing.T, name string, raw []byte) {
	t.Helper()
	if len(raw) > maxParserFuzzBytes {
		return
	}
	buf, err := DecodeAndDisarm(name, raw)
	if err != nil {
		return
	}
	if buf.Frames < 8 || buf.Frames > MaxDecodedFrames || buf.Frames != len(buf.Left) || buf.Frames != len(buf.Right) || buf.Channels != 2 || buf.SampleRate < 8000 || buf.SampleRate > 192000 {
		t.Fatal("inconsistent decoded geometry")
	}
	for i, left := range buf.Left {
		right := buf.Right[i]
		if math.IsNaN(float64(left)) || math.IsInf(float64(left), 0) || math.IsNaN(float64(right)) || math.IsInf(float64(right), 0) {
			t.Fatal("non-finite decoded PCM")
		}
	}
}
func FuzzWAVDecode(f *testing.F) {
	raw, err := EncodeWAV(make([]float32, 16), make([]float32, 16), 48000, 32)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(raw)
	f.Fuzz(func(t *testing.T, raw []byte) { checkFuzzDecoded(t, "f.wav", raw) })
}
func FuzzAIFFDecode(f *testing.F) {
	f.Add(floatAIFC(.5))
	f.Fuzz(func(t *testing.T, raw []byte) { checkFuzzDecoded(t, "f.aifc", raw) })
}
