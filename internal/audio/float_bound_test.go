package audio

import (
	"context"
	"encoding/binary"
	"errors"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"math"
	"testing"
)

func TestFloatPCMRejectsExcessiveHeadroomWithoutClipping(t *testing.T) {
	limit := float32(MaxFloatPCMAmplitude)
	for _, sample := range []float32{math.Nextafter32(limit, float32(math.Inf(1))), -math.Nextafter32(limit, float32(math.Inf(1))), math.MaxFloat32, -math.MaxFloat32} {
		samples := make([]float32, 8)
		samples[3] = sample
		raw, err := EncodeWAV(samples, samples, 48000, 32)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeAndDisarm("headroom.wav", raw); !errors.Is(err, ErrCorruptContainer) {
			t.Fatalf("sample %g was accepted: %v", sample, err)
		}
	}
	// AIFF-C uses the same policy, in both channels and after its big-endian decode.
	for _, sample := range []float32{1.5, -1.5, limit, -limit, math.MaxFloat32, -math.MaxFloat32} {
		raw := floatAIFC(sample)
		buf, err := DecodeAndDisarm("headroom.aifc", raw)
		if math.Abs(float64(sample)) > MaxFloatPCMAmplitude {
			if !errors.Is(err, ErrCorruptContainer) {
				t.Fatalf("AIFF-C %g accepted: %v", sample, err)
			}
			continue
		}
		if err != nil || buf.Right[0] != sample {
			t.Fatalf("AIFF-C changed %g: %v", sample, err)
		}
	}
}
func floatAIFC(sample float32) []byte {
	raw := make([]byte, 12)
	copy(raw, "FORM")
	copy(raw[8:], "AIFC")
	comm := make([]byte, 22)
	binary.BigEndian.PutUint16(comm, 2)
	binary.BigEndian.PutUint32(comm[2:], 8)
	binary.BigEndian.PutUint16(comm[6:], 32)
	copy(comm[8:], []byte{0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0})
	copy(comm[18:], "fl32")
	raw = append(raw, []byte("COMM")...)
	raw = binary.BigEndian.AppendUint32(raw, uint32(len(comm)))
	raw = append(raw, comm...)
	raw = append(raw, []byte("SSND")...)
	raw = binary.BigEndian.AppendUint32(raw, 72)
	raw = append(raw, make([]byte, 72)...)
	for i := 0; i < 16; i++ {
		binary.BigEndian.PutUint32(raw[len(raw)-64+i*4:], math.Float32bits(sample))
	}
	binary.BigEndian.PutUint32(raw[4:], uint32(len(raw)-8))
	return raw
}

func TestRecoverableFloatHeadroomRemainsFiniteThroughMaximumGain(t *testing.T) {
	samples := make([]float32, 128)
	for i := range samples {
		samples[i] = float32(MaxFloatPCMAmplitude)
		if i%2 == 1 {
			samples[i] = -samples[i]
		}
	}
	params := dsp.DefaultParams()
	params.InputGainDB = 36
	params.EQEnabled = true
	for i := range params.Bands {
		params.Bands[i].Enabled = true
		params.Bands[i].GainDB = 24
		params.Bands[i].Q = 20
	}
	params.Compressor.Enabled = true
	params.Compressor.MakeupDB = 36
	params.Limiter.Enabled = false
	left, right, _, err := dsp.RenderBufferContext(context.Background(), samples, samples, 48000, params)
	if err != nil {
		t.Fatal(err)
	}
	for i := range left {
		if math.IsNaN(float64(left[i])) || math.IsInf(float64(left[i]), 0) || math.IsNaN(float64(right[i])) || math.IsInf(float64(right[i]), 0) {
			t.Fatalf("non-finite output at %d", i)
		}
	}
	if samples[0] != float32(MaxFloatPCMAmplitude) {
		t.Fatal("render changed input headroom")
	}
}
