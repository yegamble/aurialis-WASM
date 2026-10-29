package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
)

// Frozen from the real browser Deep apply/export workflow that exposed ARM
// envelope FMA contraction. Source PCM16 quantization is independent of DSP.
func deepEnvelopeParityFixture(t *testing.T) offlineParityFixture {
	t.Helper()
	const rate = 48000
	left, right := make([]float32, 3*rate), make([]float32, 3*rate)
	for i := range left {
		phase := 2 * math.Pi * 997 * float64(i) / rate
		left[i] = float32(math.Floor(.2*32767*math.Sin(phase)+.5) / 32768)
		right[i] = float32(math.Floor(.1*32767*math.Sin(phase)+.5) / 32768)
	}
	source, err := audio.EncodeWAV(left, right, rate, 16)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/deep-envelope-request.json")
	if err != nil {
		t.Fatal(err)
	}
	result, err := browserjobs.Execute(context.Background(), raw, source, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(result.Audio)
	return offlineParityFixture{Request: string(raw), Source: source, AudioSHA256: hex.EncodeToString(sum[:]), Metadata: string(result.Metadata)}
}

func TestDeepEnvelopeFrozenExportBytes(t *testing.T) {
	fixture := deepEnvelopeParityFixture(t)
	// Recorded from the compiled production Go/WASM worker, not a tolerance.
	const want = "661f4061b06344eb7b1041077d2c6c179e55658f6e6cdb2c263d2a7617aeeec3"
	if fixture.AudioSHA256 != want {
		t.Fatalf("Deep float32 export SHA256 %s, want %s", fixture.AudioSHA256, want)
	}
}
