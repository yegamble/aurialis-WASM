package audio

import (
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/yegamble/Aurialis-WASM/internal/third_party/gomp3"
)

// mp3DecoderDelay is the Layer III synthesis delay that gapless metadata
// (LAME/Lavc "Info" tags) excludes from its encoder delay.
const mp3DecoderDelay = 529

type mp3Header struct {
	mpeg1      bool
	crc        bool
	mono       bool
	sampleRate int
	frameSize  int
}

var (
	mp3Bitrates1 = [15]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}
	mp3Bitrates2 = [15]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}
	mp3Rates1    = [3]int{44100, 48000, 32000}
	mp3Rates2    = [3]int{22050, 24000, 16000}
)

// parseMP3Header accepts MPEG-1 and MPEG-2 Layer III headers with a fixed bitrate
// index. MPEG-2.5, other layers, and free-format streams are not supported.
func parseMP3Header(b []byte) (mp3Header, bool) {
	if len(b) < 4 || b[0] != 0xFF || b[1]&0xE0 != 0xE0 {
		return mp3Header{}, false
	}
	version := (b[1] >> 3) & 3
	layer := (b[1] >> 1) & 3
	bitrate := int(b[2] >> 4)
	rate := int((b[2] >> 2) & 3)
	if (version != 3 && version != 2) || layer != 1 || bitrate == 0 || bitrate == 15 || rate == 3 {
		return mp3Header{}, false
	}
	h := mp3Header{mpeg1: version == 3, crc: b[1]&1 == 0, mono: b[3]>>6 == 3}
	padding := int((b[2] >> 1) & 1)
	if h.mpeg1 {
		h.sampleRate = mp3Rates1[rate]
		h.frameSize = 144*mp3Bitrates1[bitrate]*1000/h.sampleRate + padding
	} else {
		h.sampleRate = mp3Rates2[rate]
		h.frameSize = 72*mp3Bitrates2[bitrate]*1000/h.sampleRate + padding
	}
	return h, true
}

func (h mp3Header) sideInfoSize() int {
	switch {
	case h.mpeg1 && h.mono:
		return 17
	case h.mpeg1:
		return 32
	case h.mono:
		return 9
	default:
		return 17
	}
}

func (h mp3Header) samplesPerFrame() int {
	if h.mpeg1 {
		return 1152
	}
	return 576
}

// isMP3 reports whether data (after ID3v2 tags) begins with two chained Layer III frames.
func isMP3(data []byte) bool {
	first, ok := parseMP3Header(data)
	if !ok || first.frameSize >= len(data) {
		return false
	}
	second, ok := parseMP3Header(data[first.frameSize:])
	return ok && second.sampleRate == first.sampleRate && second.mpeg1 == first.mpeg1
}

// decodeAndDisarmMP3 walks the exact frame chain, scans tags and trailers for
// payloads, decodes Layer III to float PCM, and trims LAME/Lavc gapless padding.
func decodeAndDisarmMP3(raw []byte) (*Buffer, error) {
	data, err := stripID3v2(raw)
	if err != nil {
		return nil, err
	}
	first, ok := parseMP3Header(data)
	if !ok {
		return nil, fmt.Errorf("%w: missing MPEG Layer III frame", ErrCorruptContainer)
	}
	start, delay, padding := 0, -1, -1
	if frame := data[:min(first.frameSize, len(data))]; isMP3InfoFrame(frame, first) {
		delay, padding = lameGapless(frame, first)
		start = first.frameSize
	}
	end, frames := start, 0
	for end < len(data) {
		h, ok := parseMP3Header(data[end:])
		if !ok || h.sampleRate != first.sampleRate || h.mpeg1 != first.mpeg1 || end+h.frameSize > len(data) {
			break
		}
		end += h.frameSize
		frames++
	}
	if frames < 2 {
		return nil, ErrEmptyAudio
	}
	if err := checkTrailer(data[end:], "MP3 frames"); err != nil {
		return nil, err
	}
	if frames*first.samplesPerFrame() > MaxDecodedFrames+2*first.samplesPerFrame() {
		return nil, fmt.Errorf("%w: decoded audio exceeds frame limit", ErrCorruptContainer)
	}
	decoded, err := decodeMP3Frames(data[start:end], frames*first.samplesPerFrame())
	if err != nil {
		return nil, err
	}
	left, right := decoded.Left, decoded.Right
	if delay >= 0 {
		head := min(delay+mp3DecoderDelay, len(left))
		tail := len(left)
		if padding > mp3DecoderDelay {
			tail = max(head, len(left)-(padding-mp3DecoderDelay))
		}
		left, right = left[head:tail], right[head:tail]
	}
	if len(left) > MaxDecodedFrames {
		return nil, fmt.Errorf("%w: decoded audio exceeds frame limit", ErrCorruptContainer)
	}
	if len(left) < 8 {
		return nil, ErrEmptyAudio
	}
	return &Buffer{
		SampleRate: decoded.SampleRate,
		Channels:   2,
		Frames:     len(left),
		Duration:   float64(len(left)) / float64(decoded.SampleRate),
		Left:       left,
		Right:      right,
	}, nil
}

func decodeMP3Frames(data []byte, capacity int) (result *gomp3.Result, err error) {
	// The vendored decoder indexes fixed tables from bitstream fields. Convert
	// any out-of-range access on hostile input into a container error.
	defer func() {
		if recovered := recover(); recovered != nil {
			result, err = nil, fmt.Errorf("%w: undecodable MP3 frame data", ErrCorruptContainer)
		}
	}()
	result, err = gomp3.Decode(data, MaxDecodedFrames+2*1152, capacity)
	if err != nil {
		if errors.Is(err, gomp3.ErrTooLong) {
			return nil, fmt.Errorf("%w: decoded audio exceeds frame limit", ErrCorruptContainer)
		}
		return nil, fmt.Errorf("%w: %w", ErrCorruptContainer, err)
	}
	return result, nil
}

func mp3InfoOffset(h mp3Header) int {
	offset := 4 + h.sideInfoSize()
	if h.crc {
		offset += 2
	}
	return offset
}

// isMP3InfoFrame detects the Xing/Info/VBRI metadata frame, which carries no audio.
func isMP3InfoFrame(frame []byte, h mp3Header) bool {
	offset := mp3InfoOffset(h)
	if offset+4 <= len(frame) {
		if tag := string(frame[offset : offset+4]); tag == "Xing" || tag == "Info" {
			return true
		}
	}
	return len(frame) >= 40 && string(frame[36:40]) == "VBRI"
}

// lameGapless returns encoder delay and padding from a LAME-style extension of
// a Xing/Info frame, or -1, -1 when absent.
func lameGapless(frame []byte, h mp3Header) (delay, padding int) {
	offset := mp3InfoOffset(h)
	if offset+8 > len(frame) || (string(frame[offset:offset+4]) != "Xing" && string(frame[offset:offset+4]) != "Info") {
		return -1, -1
	}
	flags := binary.BigEndian.Uint32(frame[offset+4 : offset+8])
	lame := offset + 8
	for _, field := range []struct {
		bit  uint32
		size int
	}{{1, 4}, {2, 4}, {4, 100}, {8, 4}} {
		if flags&field.bit != 0 {
			lame += field.size
		}
	}
	if lame+24 > len(frame) {
		return -1, -1
	}
	for _, c := range frame[lame : lame+4] {
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return -1, -1
		}
	}
	b := frame[lame+21 : lame+24]
	return int(b[0])<<4 | int(b[1])>>4, int(b[1]&0x0F)<<8 | int(b[2])
}

// stripID3v2 removes leading ID3v2 tags after scanning their bodies for payloads.
func stripID3v2(data []byte) ([]byte, error) {
	for len(data) >= 10 && string(data[:3]) == "ID3" {
		size := 0
		for _, b := range data[6:10] {
			if b&0x80 != 0 {
				return nil, fmt.Errorf("%w: invalid ID3v2 tag size", ErrCorruptContainer)
			}
			size = size<<7 | int(b)
		}
		total := 10 + size
		if data[5]&0x10 != 0 {
			total += 10
		}
		if total > len(data) {
			return nil, fmt.Errorf("%w: ID3v2 tag overflows file bounds", ErrCorruptContainer)
		}
		if err := scanNonAudioPayloads(data[10:total]); err != nil {
			return nil, err
		}
		data = data[total:]
	}
	return data, nil
}

// checkTrailer accepts an ID3v1 tag, an APEv2 tag, or at most 64 stray bytes
// after the final audio frame; all are scanned and discarded.
func checkTrailer(rest []byte, after string) error {
	if len(rest) >= 128 && string(rest[len(rest)-128:len(rest)-125]) == "TAG" {
		if err := scanNonAudioPayloads(rest[len(rest)-128:]); err != nil {
			return err
		}
		rest = rest[:len(rest)-128]
	}
	if n := len(rest); n >= 32 && string(rest[n-32:n-24]) == "APETAGEX" {
		size := int(binary.LittleEndian.Uint32(rest[n-20 : n-16]))
		if binary.LittleEndian.Uint32(rest[n-12:n-8])&0x80000000 != 0 {
			size += 32 // header present
		}
		if size < 32 || size > n {
			return fmt.Errorf("%w: invalid APE tag", ErrCorruptContainer)
		}
		if err := scanNonAudioPayloads(rest[n-size:]); err != nil {
			return err
		}
		rest = rest[:n-size]
	}
	if len(rest) > 64 {
		return fmt.Errorf("%w: %d unexpected trailing bytes after %s", ErrPolyglotPayload, len(rest), after)
	}
	return scanNonAudioPayloads(rest)
}
