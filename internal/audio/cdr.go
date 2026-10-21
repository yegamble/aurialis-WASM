// Package audio implements Audio Content Disarm & Reconstruction (CDR),
// container validation, clean WAV synthesis, and deterministic test fixtures.
package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

var (
	// ErrInvalidFilename indicates a filename with path traversal, control chars, or banned extension.
	ErrInvalidFilename = errors.New("invalid or unsupported audio filename")
	// ErrPolyglotPayload indicates a file containing executable, archive, or script signatures.
	ErrPolyglotPayload = errors.New("polyglot or embedded non-audio payload rejected by CDR")
	// ErrCorruptContainer indicates malformed RIFF/WAV/audio headers or truncated chunk bounds.
	ErrCorruptContainer = errors.New("corrupt or unsupported audio container")
	// ErrEmptyAudio indicates an audio container with zero playable PCM frames.
	ErrEmptyAudio = errors.New("audio container has zero playable frames")
)

// Buffer holds clean, reconstructed stereo Float32 PCM samples in memory.
type Buffer struct {
	SampleRate int       `json:"sampleRate"`
	Channels   int       `json:"channels"`
	Frames     int       `json:"frames"`
	Duration   float64   `json:"duration"`
	Left       []float32 `json:"-"`
	Right      []float32 `json:"-"`
}

var pcmSlicePool = sync.Pool{
	New: func() any {
		s := make([]float32, 0, 48000*10)
		return &s
	},
}

// MaxDecodedFrames bounds the memory expansion of compressed-width PCM input.
const MaxDecodedFrames = 4 * 1024 * 1024

// AcquirePCM returns a pooled float32 slice of length n.
func AcquirePCM(n int) []float32 {
	ptr, ok := pcmSlicePool.Get().(*[]float32)
	if !ok || ptr == nil {
		return make([]float32, n)
	}
	s := *ptr
	if cap(s) < n {
		return make([]float32, n)
	}
	return s[:n]
}

// ReleasePCM zeroes and returns a float32 slice to the pool.
func ReleasePCM(s []float32) {
	if cap(s) == 0 || cap(s) > 48000*60*15 {
		return
	}
	clear(s)
	empty := s[:0]
	pcmSlicePool.Put(&empty)
}

var allowedExtensions = map[string]bool{
	".wav":  true,
	".wave": true,
	".mp3":  true,
	".flac": true,
	".aiff": true,
	".aif":  true,
	".ogg":  true,
	".m4a":  true,
	".aac":  true,
}

// SanitizeFilename validates an uploaded filename against CRLF injection, null bytes,
// Unicode bidirectional RTLO spoofing, path traversal, and unsupported extensions.
func SanitizeFilename(rawName string) (string, error) {
	trimmed := strings.TrimSpace(rawName)
	if trimmed == "" {
		return "", fmt.Errorf("%w: empty filename", ErrInvalidFilename)
	}
	for _, r := range trimmed {
		if r == '\r' || r == '\n' || r == '\x00' || r < 0x20 || unicode.IsControl(r) {
			return "", fmt.Errorf("%w: control character in filename", ErrInvalidFilename)
		}
		// Reject Unicode bidirectional override characters (RTLO U+202E, etc.)
		if (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			return "", fmt.Errorf("%w: unicode direction override in filename", ErrInvalidFilename)
		}
	}
	if strings.Contains(trimmed, "..") || strings.Contains(trimmed, "/") || strings.Contains(trimmed, `\`) {
		return "", fmt.Errorf("%w: path traversal sequence in filename", ErrInvalidFilename)
	}
	base := filepath.Base(trimmed)
	ext := strings.ToLower(filepath.Ext(base))
	if !allowedExtensions[ext] {
		return "", fmt.Errorf("%w: unsupported extension %q", ErrInvalidFilename, ext)
	}
	return base, nil
}

// ScanPolyglotPayloads inspects raw upload bytes for executable headers, scripts, PDFs,
// or embedded ZIP/JAR/archive trailers (e.g., WAV+ZIP polyglots).
func ScanPolyglotPayloads(data []byte) error {
	if len(data) < 12 {
		return fmt.Errorf("%w: file too short (%d bytes)", ErrCorruptContainer, len(data))
	}
	// Check leading magic signatures for non-audio binaries
	switch {
	case bytes.HasPrefix(data, []byte("MZ")):
		return fmt.Errorf("%w: Windows PE MZ signature detected", ErrPolyglotPayload)
	case bytes.HasPrefix(data, []byte("\x7fELF")):
		return fmt.Errorf("%w: ELF binary signature detected", ErrPolyglotPayload)
	case bytes.HasPrefix(data, []byte("\xfe\xed\xfa\xce")) ||
		bytes.HasPrefix(data, []byte("\xfe\xed\xfa\xcf")) ||
		bytes.HasPrefix(data, []byte("\xce\xfa\xed\xfe")) ||
		bytes.HasPrefix(data, []byte("\xcf\xfa\xed\xfe")):
		return fmt.Errorf("%w: Mach-O binary signature detected", ErrPolyglotPayload)
	case bytes.HasPrefix(data, []byte("%PDF-")):
		return fmt.Errorf("%w: PDF document signature detected", ErrPolyglotPayload)
	case bytes.HasPrefix(data, []byte("#!")):
		return fmt.Errorf("%w: shell script shebang detected", ErrPolyglotPayload)
	}

	// Scan the bounded upload for ZIP/JAR markers, plus header/trailer script markers.
	scanSlice := data
	if bytes.Contains(scanSlice, []byte("PK\x03\x04")) || bytes.Contains(scanSlice, []byte("PK\x05\x06")) {
		return fmt.Errorf("%w: embedded ZIP/JAR archive signature (PK) detected", ErrPolyglotPayload)
	}
	lowerHead := bytes.ToLower(data[:minInt(len(data), 4096)])
	if bytes.Contains(lowerHead, []byte("<script")) || bytes.Contains(lowerHead, []byte("<?php")) || bytes.Contains(lowerHead, []byte("<!doctype html")) {
		return fmt.Errorf("%w: embedded HTML/script payload detected", ErrPolyglotPayload)
	}
	if len(data) > 4096 {
		tail := data[len(data)-4096:]
		if bytes.Contains(tail, []byte("PK\x03\x04")) || bytes.Contains(tail, []byte("PK\x05\x06")) ||
			bytes.Contains(bytes.ToLower(tail), []byte("<script")) {
			return fmt.Errorf("%w: trailing polyglot payload detected", ErrPolyglotPayload)
		}
	}
	return nil
}

// DecodeAndDisarm validates the uploaded file name and container, strips all metadata/unknown
// chunks, rejects polyglots, and decodes clean stereo Float32 PCM samples.
func DecodeAndDisarm(filename string, raw []byte) (*Buffer, error) {
	if _, err := SanitizeFilename(filename); err != nil {
		return nil, err
	}
	if err := ScanPolyglotPayloads(raw); err != nil {
		return nil, err
	}

	switch {
	case len(raw) >= 12 && string(raw[0:4]) == "RIFF" && string(raw[8:12]) == "WAVE":
		return decodeAndDisarmWAV(raw)
	case len(raw) >= 12 && string(raw[0:4]) == "FORM" && string(raw[8:12]) == "AIFF":
		return decodeAndDisarmAIFF(raw)
	default:
		return nil, fmt.Errorf("%w: unrecognized or spoofed audio container magic bytes", ErrCorruptContainer)
	}
}

func decodeAndDisarmWAV(raw []byte) (*Buffer, error) {
	if len(raw) < 44 {
		return nil, fmt.Errorf("%w: WAV shorter than 44-byte minimum header", ErrCorruptContainer)
	}
	riffSize := binary.LittleEndian.Uint32(raw[4:8])
	if riffSize < 36 || uint64(riffSize)+8 != uint64(len(raw)) {
		return nil, fmt.Errorf("%w: invalid RIFF chunk size %d", ErrCorruptContainer, riffSize)
	}

	var (
		hasFmt        bool
		audioFormat   uint16
		numChannels   uint16
		sampleRate    uint32
		bitsPerSample uint16
		pcmData       []byte
		dataEndOffset int
		blockAlign    uint16
		byteRate      uint32
	)

	offset := 12
	for offset+8 <= len(raw) {
		chunkID := string(raw[offset : offset+4])
		chunkSize := binary.LittleEndian.Uint32(raw[offset+4 : offset+8])
		offset += 8

		if chunkSize == 0xFFFFFFFF || int64(offset)+int64(chunkSize) > int64(len(raw)) {
			return nil, fmt.Errorf("%w: chunk %q size %d exceeds file bounds (%d)", ErrCorruptContainer, chunkID, chunkSize, len(raw))
		}
		chunkBytes := raw[offset : offset+int(chunkSize)]

		switch chunkID {
		case "fmt ":
			if hasFmt {
				return nil, fmt.Errorf("%w: duplicate fmt chunk", ErrCorruptContainer)
			}
			if chunkSize < 16 {
				return nil, fmt.Errorf("%w: fmt chunk smaller than 16 bytes", ErrCorruptContainer)
			}
			audioFormat = binary.LittleEndian.Uint16(chunkBytes[0:2])
			numChannels = binary.LittleEndian.Uint16(chunkBytes[2:4])
			sampleRate = binary.LittleEndian.Uint32(chunkBytes[4:8])
			bitsPerSample = binary.LittleEndian.Uint16(chunkBytes[14:16])
			blockAlign = binary.LittleEndian.Uint16(chunkBytes[12:14])
			byteRate = binary.LittleEndian.Uint32(chunkBytes[8:12])
			hasFmt = true
		case "data":
			if dataEndOffset != 0 {
				return nil, fmt.Errorf("%w: duplicate data chunk", ErrCorruptContainer)
			}
			pcmData = chunkBytes
			dataEndOffset = offset + int(chunkSize)
		default:
			// CDR: Strip LIST, INFO, ID3, JUNK, PAD, bext, cue, smpl, or unknown chunks.
			// Still inspect stripped chunk content for embedded polyglot signatures.
			if bytes.Contains(chunkBytes, []byte("PK\x03\x04")) || bytes.Contains(chunkBytes, []byte("\x7fELF")) {
				return nil, fmt.Errorf("%w: malicious signature inside %q chunk", ErrPolyglotPayload, chunkID)
			}
		}

		offset += int(chunkSize)
		// RIFF word alignment padding byte
		if chunkSize%2 == 1 {
			if offset >= len(raw) {
				return nil, fmt.Errorf("%w: missing chunk alignment byte", ErrCorruptContainer)
			}
			offset++
		}
	}
	if offset != len(raw) {
		return nil, fmt.Errorf("%w: incomplete RIFF chunk", ErrCorruptContainer)
	}

	if !hasFmt {
		return nil, fmt.Errorf("%w: missing fmt chunk", ErrCorruptContainer)
	}
	if audioFormat != 1 && audioFormat != 3 {
		return nil, fmt.Errorf("%w: unsupported WAV format tag %d", ErrCorruptContainer, audioFormat)
	}
	if numChannels < 1 || numChannels > 2 {
		return nil, fmt.Errorf("%w: invalid channel count %d", ErrCorruptContainer, numChannels)
	}
	if sampleRate < 8000 || sampleRate > 192000 {
		return nil, fmt.Errorf("%w: unsupported sample rate %d Hz", ErrCorruptContainer, sampleRate)
	}
	if bitsPerSample != 8 && bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32 {
		return nil, fmt.Errorf("%w: unsupported bit depth %d", ErrCorruptContainer, bitsPerSample)
	}
	if audioFormat == 3 && bitsPerSample != 32 {
		return nil, fmt.Errorf("%w: floating point WAV requires 32 bits", ErrCorruptContainer)
	}
	expectedAlign := uint32(numChannels) * uint32(bitsPerSample/8)
	if uint32(blockAlign) != expectedAlign || byteRate != sampleRate*expectedAlign {
		return nil, fmt.Errorf("%w: inconsistent PCM layout", ErrCorruptContainer)
	}
	if len(pcmData) == 0 {
		return nil, ErrEmptyAudio
	}

	// CDR check: reject substantial unchunked trailing payloads appended after the last valid RIFF chunk
	if dataEndOffset > 0 && offset < len(raw) {
		trailing := raw[offset:]
		if len(trailing) > 64 {
			return nil, fmt.Errorf("%w: %d unexpected trailing bytes after RIFF chunks", ErrPolyglotPayload, len(trailing))
		}
	}

	bytesPerSample := int(bitsPerSample) / 8
	frameSize := bytesPerSample * int(numChannels)
	if frameSize <= 0 || len(pcmData) < frameSize {
		return nil, ErrEmptyAudio
	}
	numFrames := len(pcmData) / frameSize
	if len(pcmData)%frameSize != 0 || numFrames > MaxDecodedFrames {
		return nil, fmt.Errorf("%w: partial frame or decoded audio exceeds frame limit", ErrCorruptContainer)
	}
	if numFrames < 8 {
		return nil, ErrEmptyAudio
	}

	left := make([]float32, numFrames)
	right := make([]float32, numFrames)

	for f := 0; f < numFrames; f++ {
		base := f * frameSize
		sL := decodeSampleLE(pcmData[base:base+bytesPerSample], audioFormat, bitsPerSample)
		sR := sL
		if numChannels >= 2 {
			sR = decodeSampleLE(pcmData[base+bytesPerSample:base+2*bytesPerSample], audioFormat, bitsPerSample)
		}
		left[f] = sL
		right[f] = sR
	}

	return &Buffer{
		SampleRate: int(sampleRate),
		Channels:   2,
		Frames:     numFrames,
		Duration:   float64(numFrames) / float64(sampleRate),
		Left:       left,
		Right:      right,
	}, nil
}

func decodeSampleLE(b []byte, audioFormat, bitsPerSample uint16) float32 {
	switch bitsPerSample {
	case 8:
		return (float32(b[0]) - 128.0) / 128.0
	case 16:
		v := int16(binary.LittleEndian.Uint16(b[0:2])) // #nosec G115 -- intentional 16-bit two's complement PCM bit reinterpretation
		return float32(v) / 32768.0
	case 24:
		u := uint32(b[0]) | (uint32(b[1]) << 8) | (uint32(b[2]) << 16)
		if u&0x800000 != 0 {
			u |= 0xFF000000
		}
		v := int32(u) // #nosec G115 -- intentional 24-bit sign-extended two's complement PCM bit reinterpretation
		return float32(v) / 8388608.0
	case 32:
		u := binary.LittleEndian.Uint32(b[0:4])
		if audioFormat == 3 {
			f := math.Float32frombits(u)
			if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
				return 0.0
			}
			if f > 1.0 {
				return 1.0
			} else if f < -1.0 {
				return -1.0
			}
			return f
		}
		v := int32(u) // #nosec G115 -- intentional 32-bit two's complement PCM bit reinterpretation
		return float32(float64(v) / 2147483648.0)
	default:
		return 0.0
	}
}

func decodeAndDisarmAIFF(raw []byte) (*Buffer, error) {
	if len(raw) < 54 {
		return nil, fmt.Errorf("%w: AIFF header too short", ErrCorruptContainer)
	}
	if uint64(binary.BigEndian.Uint32(raw[4:8]))+8 != uint64(len(raw)) {
		return nil, fmt.Errorf("%w: invalid FORM size", ErrCorruptContainer)
	}
	var (
		numChannels   uint16
		numFrames     uint32
		bitsPerSample uint16
		sampleRate    int
		ssndData      []byte
	)
	offset := 12
	for offset+8 <= len(raw) {
		chunkID := string(raw[offset : offset+4])
		chunkSize := binary.BigEndian.Uint32(raw[offset+4 : offset+8])
		offset += 8
		if chunkSize == 0xFFFFFFFF || int64(offset)+int64(chunkSize) > int64(len(raw)) {
			return nil, fmt.Errorf("%w: AIFF chunk %q overflows file bounds", ErrCorruptContainer, chunkID)
		}
		chunkBytes := raw[offset : offset+int(chunkSize)]
		switch chunkID {
		case "COMM":
			if numChannels != 0 {
				return nil, fmt.Errorf("%w: duplicate COMM chunk", ErrCorruptContainer)
			}
			if len(chunkBytes) < 18 {
				return nil, fmt.Errorf("%w: AIFF COMM chunk too short", ErrCorruptContainer)
			}
			numChannels = binary.BigEndian.Uint16(chunkBytes[0:2])
			numFrames = binary.BigEndian.Uint32(chunkBytes[2:6])
			bitsPerSample = binary.BigEndian.Uint16(chunkBytes[6:8])
			sampleRate = parseIEEE80SampleRate(chunkBytes[8:18])
		case "SSND":
			if ssndData != nil {
				return nil, fmt.Errorf("%w: duplicate SSND chunk", ErrCorruptContainer)
			}
			if len(chunkBytes) < 8 {
				return nil, fmt.Errorf("%w: AIFF SSND chunk too short", ErrCorruptContainer)
			}
			dataOffset := binary.BigEndian.Uint32(chunkBytes[0:4])
			if int64(8)+int64(dataOffset) > int64(len(chunkBytes)) {
				return nil, fmt.Errorf("%w: AIFF SSND offset out of bounds", ErrCorruptContainer)
			}
			ssndData = chunkBytes[8+int(dataOffset):]
		}
		offset += int(chunkSize)
		if chunkSize%2 == 1 {
			if offset >= len(raw) {
				return nil, fmt.Errorf("%w: missing chunk alignment byte", ErrCorruptContainer)
			}
			offset++
		}
	}
	if offset != len(raw) {
		return nil, fmt.Errorf("%w: incomplete AIFF chunk", ErrCorruptContainer)
	}
	if numChannels < 1 || numChannels > 2 || sampleRate < 8000 || sampleRate > 192000 || bitsPerSample != 16 || len(ssndData) == 0 {
		return nil, fmt.Errorf("%w: invalid AIFF parameters", ErrCorruptContainer)
	}
	frameSize := 2 * int(numChannels)
	availFrames := len(ssndData) / frameSize
	if uint64(numFrames) != uint64(availFrames) || len(ssndData)%frameSize != 0 || availFrames > MaxDecodedFrames {
		return nil, fmt.Errorf("%w: inconsistent or excessive AIFF frames", ErrCorruptContainer)
	}
	if availFrames < 8 {
		return nil, ErrEmptyAudio
	}
	left := make([]float32, availFrames)
	right := make([]float32, availFrames)
	for f := 0; f < availFrames; f++ {
		base := f * frameSize
		sL := float32(int16(binary.BigEndian.Uint16(ssndData[base:base+2]))) / 32768.0 // #nosec G115 -- 16-bit PCM two's complement
		sR := sL
		if numChannels >= 2 {
			sR = float32(int16(binary.BigEndian.Uint16(ssndData[base+2:base+4]))) / 32768.0 // #nosec G115 -- 16-bit PCM two's complement
		}
		left[f] = sL
		right[f] = sR
	}
	return &Buffer{
		SampleRate: sampleRate,
		Channels:   2,
		Frames:     availFrames,
		Duration:   float64(availFrames) / float64(sampleRate),
		Left:       left,
		Right:      right,
	}, nil
}

func parseIEEE80SampleRate(b []byte) int {
	if len(b) < 10 || b[0]&0x80 != 0 {
		return 0
	}
	exp := int(binary.BigEndian.Uint16(b[0:2])&0x7FFF) - 16383
	mant := binary.BigEndian.Uint64(b[2:10])
	if exp < 0 || exp > 30 || mant&(uint64(1)<<63) == 0 {
		return 0
	}
	shift := 63 - exp
	if shift < 33 || shift >= 64 {
		return 0
	}
	shifted := mant >> shift
	if shifted < 8000 || shifted > 192000 {
		return 0
	}
	return int(shifted) // #nosec G115 -- bounded to [8000, 192000]
}

func safeUint32(v int) uint32 {
	if v <= 0 {
		return 0
	}
	if int64(v) > int64(math.MaxUint32) {
		return math.MaxUint32
	}
	return uint32(v) // #nosec G115 -- bounded to [0, MaxUint32]
}

func safeUint16(v int) uint16 {
	if v <= 0 {
		return 0
	}
	if v > math.MaxUint16 {
		return math.MaxUint16
	}
	return uint16(v)
}

// EncodeWAV synthesizes a clean, metadata-free RIFF/WAVE binary from stereo Float32 samples
// at 16-bit, 24-bit, or 32-bit float resolution.
func EncodeWAV(left, right []float32, sampleRate, bitDepth int) ([]byte, error) {
	n := len(left)
	if len(right) < n {
		n = len(right)
	}
	if n == 0 {
		return nil, ErrEmptyAudio
	}
	if sampleRate < 8000 {
		sampleRate = 48000
	}
	if bitDepth != 16 && bitDepth != 24 && bitDepth != 32 {
		bitDepth = 16
	}

	bytesPerSample := bitDepth / 8
	numChannels := 2
	blockAlign := numChannels * bytesPerSample
	byteRate := sampleRate * blockAlign
	dataSize := n * blockAlign
	riffSize := 36 + dataSize

	out := make([]byte, 44+dataSize)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], safeUint32(riffSize))
	copy(out[8:12], "WAVE")
	copy(out[12:16], "fmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	audioFormat := uint16(1)
	if bitDepth == 32 {
		audioFormat = 3 // IEEE Float
	}
	binary.LittleEndian.PutUint16(out[20:22], audioFormat)
	binary.LittleEndian.PutUint16(out[22:24], safeUint16(numChannels))
	binary.LittleEndian.PutUint32(out[24:28], safeUint32(sampleRate))
	binary.LittleEndian.PutUint32(out[28:32], safeUint32(byteRate))
	binary.LittleEndian.PutUint16(out[32:34], safeUint16(blockAlign))
	binary.LittleEndian.PutUint16(out[34:36], safeUint16(bitDepth))
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], safeUint32(dataSize))

	offset := 44
	for i := 0; i < n; i++ {
		samples := [2]float32{left[i], right[i]}
		for ch := 0; ch < 2; ch++ {
			s := float64(samples[ch])
			if math.IsNaN(s) || math.IsInf(s, 0) {
				s = 0.0
			}
			if s > 1.0 {
				s = 1.0
			} else if s < -1.0 {
				s = -1.0
			}
			switch bitDepth {
			case 16:
				scaled := int32(math.Round(s * 32767.0))
				u16 := uint16(scaled & 0xFFFF) // #nosec G115 -- clamped to [-32767, 32767]
				binary.LittleEndian.PutUint16(out[offset:offset+2], u16)
				offset += 2
			case 24:
				scaled := int32(math.Round(s * 8388607.0))
				out[offset] = byte(scaled & 0xff)
				out[offset+1] = byte((scaled >> 8) & 0xff)
				out[offset+2] = byte((scaled >> 16) & 0xff)
				offset += 3
			case 32:
				binary.LittleEndian.PutUint32(out[offset:offset+4], math.Float32bits(float32(s)))
				offset += 4
			}
		}
	}
	return out, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
