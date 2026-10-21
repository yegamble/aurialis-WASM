package audio

import (
	"encoding/binary"
	"testing"
)

func TestWAVRejectsInconsistentContainerLayout(t *testing.T) {
	wav, err := EncodeWAV(make([]float32, 16), make([]float32, 16), 48000, 16)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func([]byte) []byte{
		"RIFF length":     func(b []byte) []byte { binary.LittleEndian.PutUint32(b[4:8], 0); return b },
		"float16":         func(b []byte) []byte { binary.LittleEndian.PutUint16(b[20:22], 3); return b },
		"block alignment": func(b []byte) []byte { binary.LittleEndian.PutUint16(b[32:34], 1); return b },
		"byte rate":       func(b []byte) []byte { binary.LittleEndian.PutUint32(b[28:32], 1); return b },
		"partial frame": func(b []byte) []byte {
			b = append(b, 0)
			binary.LittleEndian.PutUint32(b[4:8], safeUint32(len(b)-8))
			binary.LittleEndian.PutUint32(b[40:44], 65)
			return b
		},
		"duplicate data": func(b []byte) []byte {
			b = append(b, b[36:]...)
			binary.LittleEndian.PutUint32(b[4:8], safeUint32(len(b)-8))
			return b
		},
		"duplicate format": func(b []byte) []byte {
			b = append(b, b[12:36]...)
			binary.LittleEndian.PutUint32(b[4:8], safeUint32(len(b)-8))
			return b
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeAndDisarm("track.wav", mutate(append([]byte{}, wav...))); err == nil {
				t.Fatal("malformed container accepted")
			}
		})
	}
}

func TestDecodedFrameExpansionIsBounded(t *testing.T) {
	// A mono 8-bit container expands to two float32 channels. Validate its frame
	// count before allocating either decoded channel.
	raw := make([]byte, 44+MaxDecodedFrames+2)
	copy(raw, "RIFF")
	binary.LittleEndian.PutUint32(raw[4:8], safeUint32(len(raw)-8))
	copy(raw[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(raw[16:20], 16)
	binary.LittleEndian.PutUint16(raw[20:22], 1)
	binary.LittleEndian.PutUint16(raw[22:24], 1)
	binary.LittleEndian.PutUint32(raw[24:28], 48000)
	binary.LittleEndian.PutUint32(raw[28:32], 48000)
	binary.LittleEndian.PutUint16(raw[32:34], 1)
	binary.LittleEndian.PutUint16(raw[34:36], 8)
	copy(raw[36:], "data")
	binary.LittleEndian.PutUint32(raw[40:44], safeUint32(len(raw)-44))
	if _, err := DecodeAndDisarm("large.wav", raw); err == nil {
		t.Fatal("decoded expansion exceeded frame cap")
	}
}

func TestAIFFRateAndCompressionFailClosed(t *testing.T) {
	valid := []byte{0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0}
	if got := parseIEEE80SampleRate(valid); got != 48000 {
		t.Fatalf("valid sample rate=%d", got)
	}
	for _, raw := range [][]byte{{}, {0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, {0xc0, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0}, {0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}} {
		if got := parseIEEE80SampleRate(raw); got != 0 {
			t.Fatalf("malformed rate accepted=%d", got)
		}
	}
	aifc := make([]byte, 64)
	copy(aifc, "FORM")
	binary.BigEndian.PutUint32(aifc[4:8], 56)
	copy(aifc[8:], "AIFC")
	if _, err := DecodeAndDisarm("compressed.aif", aifc); err == nil {
		t.Fatal("unsupported AIFC accepted")
	}
}

func TestCDRReconstructsWithoutMetadata(t *testing.T) {
	wav, err := EncodeWAV(make([]float32, 16), make([]float32, 16), 48000, 16)
	if err != nil {
		t.Fatal(err)
	}
	withMetadata := append(append([]byte{}, wav...), []byte("JUNK\x08\x00\x00\x00metadata")...)
	binary.LittleEndian.PutUint32(withMetadata[4:8], safeUint32(len(withMetadata)-8))
	decoded, err := DecodeAndDisarm("track.wav", withMetadata)
	if err != nil {
		t.Fatal(err)
	}
	clean, err := EncodeWAV(decoded.Left, decoded.Right, decoded.SampleRate, 16)
	if err != nil {
		t.Fatal(err)
	}
	if string(clean) != string(wav) {
		t.Fatal("reconstructed output retained non-audio chunks")
	}
}
