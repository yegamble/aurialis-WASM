package audio_test

import (
	"context"
	"encoding/binary"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestFloatWAVPreservesHeadroomThroughNativePreviewAndExport(t *testing.T) {
	samples := []float32{1.25, -1.5, 1.5, -1.25, 0.5, -0.5, 0, 1}
	raw := make([]byte, 44+len(samples)*8)
	copy(raw, "RIFF")
	binary.LittleEndian.PutUint32(raw[4:8], 100)
	copy(raw[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(raw[16:20], 16)
	binary.LittleEndian.PutUint16(raw[20:22], 3)
	binary.LittleEndian.PutUint16(raw[22:24], 2)
	binary.LittleEndian.PutUint32(raw[24:28], 48000)
	binary.LittleEndian.PutUint32(raw[28:32], 384000)
	binary.LittleEndian.PutUint16(raw[32:34], 8)
	binary.LittleEndian.PutUint16(raw[34:36], 32)
	copy(raw[36:], "data")
	binary.LittleEndian.PutUint32(raw[40:44], 64)
	for i, sample := range samples {
		binary.LittleEndian.PutUint32(raw[44+i*8:], math.Float32bits(sample))
		binary.LittleEndian.PutUint32(raw[48+i*8:], math.Float32bits(-sample))
	}
	buf, err := audio.DecodeAndDisarm("float.wav", raw)
	if err != nil {
		t.Fatal(err)
	}
	params := dsp.DefaultParams()
	params.Bypass = true
	previewL, previewR, _, err := dsp.RenderBufferContext(context.Background(), buf.Left, buf.Right, 48000, params)
	if err != nil {
		t.Fatal(err)
	}
	exported, err := audio.EncodeWAV(previewL, previewR, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	for i, sample := range samples {
		actualL := math.Float32frombits(binary.LittleEndian.Uint32(exported[44+i*8:]))
		actualR := math.Float32frombits(binary.LittleEndian.Uint32(exported[48+i*8:]))
		if buf.Left[i] != sample || previewL[i] != sample || actualL != sample || actualR != -sample {
			t.Fatalf("frame%d input=%g decoded=%g preview=%g exported=%g/%g", i, sample, buf.Left[i], previewL[i], actualL, actualR)
		}
	}
	for _, bits := range []int{16, 24} {
		integerWAV, encodeErr := audio.EncodeWAV(previewL, previewR, 48000, bits)
		if encodeErr != nil {
			t.Fatal(encodeErr)
		}
		integer, decodeErr := audio.DecodeAndDisarm("integer.wav", integerWAV)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		for _, sample := range integer.Left {
			if sample > 1 || sample < -1 {
				t.Fatal("integer export exceeded full scale")
			}
		}
	}
}

func TestPCMBytesAreNotPayloadSignatures(t *testing.T) {
	wav, err := audio.EncodeWAV(make([]float32, 16), make([]float32, 16), 48000, 16)
	if err != nil {
		t.Fatal(err)
	}
	copy(wav[44:], []byte("PK\x03\x04<script>\x7fELF%PDF-"))
	if _, err := audio.DecodeAndDisarm("valid-pcm.wav", wav); err != nil {
		t.Fatalf("arbitrary PCM bytes rejected: %v", err)
	}
	trailer := append(append([]byte{}, wav...), []byte("PK\x03\x04<script>")...)
	if _, err := audio.DecodeAndDisarm("trailer.wav", trailer); err == nil {
		t.Fatal("payload outside the declared RIFF container accepted")
	}
	metadata := append(append([]byte{}, wav...), []byte("JUNK\x08\x00\x00\x00<script>")...)
	binary.LittleEndian.PutUint32(metadata[4:8], 116)
	if _, err := audio.DecodeAndDisarm("metadata.wav", metadata); err == nil {
		t.Fatal("script inside non-audio metadata accepted")
	}
}

func TestFloatWAVFiniteRangeAndNonFiniteSanitization(t *testing.T) {
	samples := []float32{math.MaxFloat32, -math.MaxFloat32, float32(math.NaN()), float32(math.Inf(1)), 1.5, -1.5, 0, 1}
	wav, err := audio.EncodeWAV(samples, samples, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	// Inject non-finite bits directly to verify the decoder independently of the
	// encoder's non-finite sanitization.
	binary.LittleEndian.PutUint32(wav[44+2*8:], math.Float32bits(float32(math.NaN())))
	binary.LittleEndian.PutUint32(wav[44+3*8:], math.Float32bits(float32(math.Inf(1))))
	buf, err := audio.DecodeAndDisarm("finite-range.wav", wav)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range samples {
		if math.IsNaN(float64(want)) || math.IsInf(float64(want), 0) {
			want = 0
		}
		if buf.Left[i] != want {
			t.Fatalf("frame%d actual=%g want=%g", i, buf.Left[i], want)
		}
	}
}
