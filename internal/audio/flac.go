package audio

import (
	"bytes"
	"crypto/md5" // #nosec G501 -- FLAC STREAMINFO defines an MD5 integrity signature, not a security hash
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/bits"
)

var errFLACBits = errors.New("FLAC bitstream ended early")

// flacBits reads big-endian bit fields from a byte slice.
type flacBits struct {
	data []byte
	pos  int // bit offset
}

func (r *flacBits) read(n uint) (uint64, error) {
	if n == 0 {
		return 0, nil
	}
	if r.pos+int(n) > len(r.data)*8 {
		return 0, errFLACBits
	}
	if byteIndex := r.pos >> 3; n <= 56 && byteIndex+8 <= len(r.data) {
		word := binary.BigEndian.Uint64(r.data[byteIndex:])
		v := word << uint(r.pos&7) >> (64 - n)
		r.pos += int(n)
		return v, nil
	}
	var v uint64
	for n > 0 {
		byteIndex := r.pos >> 3
		offset := uint(r.pos & 7)
		take := min(8-offset, n)
		chunk := (uint64(r.data[byteIndex]) >> (8 - offset - take)) & (1<<take - 1)
		v = v<<take | chunk
		r.pos += int(take)
		n -= take
	}
	return v, nil
}

func (r *flacBits) signed(n uint) (int64, error) {
	v, err := r.read(n)
	if err != nil || n == 0 {
		return 0, err
	}
	shift := 64 - n
	return int64(v<<shift) >> shift, nil // #nosec G115 -- two's complement sign extension
}

// unary counts zero bits before the next one bit.
func (r *flacBits) unary() (uint64, error) {
	var count uint64
	for {
		byteIndex := r.pos >> 3
		if byteIndex >= len(r.data) {
			return 0, errFLACBits
		}
		offset := uint(r.pos & 7)
		rest := r.data[byteIndex] << offset
		if rest != 0 {
			z := uint(bits.LeadingZeros8(rest))
			count += uint64(z)
			r.pos += int(z) + 1
			return count, nil
		}
		count += uint64(8 - offset)
		r.pos += int(8 - offset)
	}
}

func (r *flacBits) align() { r.pos = (r.pos + 7) &^ 7 }

type flacStreamInfo struct {
	minBlock, maxBlock int
	sampleRate         int
	channels           int
	bitsPerSample      int
	totalSamples       uint64
	md5                [16]byte
}

const flacMaxChannels = 8

// decodeAndDisarmFLAC parses a native FLAC stream, scans all metadata blocks for
// embedded payloads, verifies every frame CRC and the STREAMINFO MD5, and
// reconstructs clean stereo float PCM. Mono is duplicated; more than two
// channels is rejected like multichannel WAV.
func decodeAndDisarmFLAC(raw []byte) (*Buffer, error) {
	data, err := stripID3v2(raw)
	if err != nil {
		return nil, err
	}
	if len(data) < 42 || string(data[:4]) != "fLaC" {
		return nil, fmt.Errorf("%w: missing FLAC stream marker", ErrCorruptContainer)
	}
	info, offset, err := parseFLACMetadata(data)
	if err != nil {
		return nil, err
	}
	capacity := MaxDecodedFrames
	if info.totalSamples > 0 {
		if info.totalSamples > MaxDecodedFrames {
			return nil, fmt.Errorf("%w: FLAC declares more than the frame limit", ErrCorruptContainer)
		}
		capacity = int(info.totalSamples)
	}
	// Reserve PCM only as validated frames arrive; STREAMINFO is untrusted.
	var left, right []float32
	scale := float32(1 / math.Ldexp(1, info.bitsPerSample-1))
	hash := md5.New() // #nosec G401 -- format-defined integrity check
	var (
		blockBuf [flacMaxChannels][]int64
		sampleLE []byte
	)
	bytesPerSample := (info.bitsPerSample + 7) / 8
	for offset < len(data) {
		if info.totalSamples > 0 && uint64(len(left)) >= info.totalSamples {
			break
		}
		if len(data)-offset < 2 || data[offset] != 0xFF || data[offset+1]&0xFE != 0xF8 {
			break
		}
		n, frameLen, err := decodeFLACFrame(data[offset:], info, &blockBuf)
		if err != nil {
			return nil, err
		}
		offset += frameLen
		if len(left)+n > capacity {
			return nil, fmt.Errorf("%w: FLAC frames exceed declared or maximum length", ErrCorruptContainer)
		}
		if len(left)+n > cap(left) {
			// Grow by validated blocks, doubling to keep cumulative copies bounded.
			nextCapacity := min(capacity, max(len(left)+n, 2*cap(left)))
			left = append(make([]float32, 0, nextCapacity), left...)
			right = append(make([]float32, 0, nextCapacity), right...)
		}
		sampleLE = sampleLE[:0]
		for i := range n {
			for ch := range info.channels {
				var b [8]byte
				binary.LittleEndian.PutUint64(b[:], uint64(blockBuf[ch][i])) // #nosec G115 -- signed sample bytes for MD5
				sampleLE = append(sampleLE, b[:bytesPerSample]...)
			}
			l := float32(blockBuf[0][i]) * scale
			rr := l
			if info.channels > 1 {
				rr = float32(blockBuf[1][i]) * scale
			}
			left = append(left, l)
			right = append(right, rr)
		}
		hash.Write(sampleLE)
	}
	if info.totalSamples > 0 && uint64(len(left)) != info.totalSamples {
		return nil, fmt.Errorf("%w: FLAC stream truncated (%d of %d frames)", ErrCorruptContainer, len(left), info.totalSamples)
	}
	if err := checkTrailer(data[offset:], "FLAC frames"); err != nil {
		return nil, err
	}
	if info.md5 != ([16]byte{}) && !bytes.Equal(hash.Sum(nil), info.md5[:]) {
		return nil, fmt.Errorf("%w: FLAC audio MD5 signature mismatch", ErrCorruptContainer)
	}
	if len(left) < 8 {
		return nil, ErrEmptyAudio
	}
	return &Buffer{
		SampleRate: info.sampleRate,
		Channels:   2,
		Frames:     len(left),
		Duration:   float64(len(left)) / float64(info.sampleRate),
		Left:       left,
		Right:      right,
	}, nil
}

func parseFLACMetadata(data []byte) (flacStreamInfo, int, error) {
	var info flacStreamInfo
	offset := 4
	first := true
	for {
		if offset+4 > len(data) {
			return info, 0, fmt.Errorf("%w: truncated FLAC metadata", ErrCorruptContainer)
		}
		header := data[offset]
		last := header&0x80 != 0
		kind := header & 0x7F
		length := int(data[offset+1])<<16 | int(data[offset+2])<<8 | int(data[offset+3])
		offset += 4
		if offset+length > len(data) {
			return info, 0, fmt.Errorf("%w: FLAC metadata block overflows file bounds", ErrCorruptContainer)
		}
		block := data[offset : offset+length]
		switch {
		case first && kind != 0:
			return info, 0, fmt.Errorf("%w: FLAC STREAMINFO must come first", ErrCorruptContainer)
		case kind == 0:
			if !first || length != 34 {
				return info, 0, fmt.Errorf("%w: invalid FLAC STREAMINFO", ErrCorruptContainer)
			}
			parsed, err := parseFLACStreamInfo(block)
			if err != nil {
				return info, 0, err
			}
			info = parsed
		case kind == 127:
			return info, 0, fmt.Errorf("%w: invalid FLAC metadata block type", ErrCorruptContainer)
		default:
			// Comments, pictures, cue sheets and application data are discarded
			// by reconstruction, but must not carry executable payloads.
			if err := scanNonAudioPayloads(block); err != nil {
				return info, 0, err
			}
		}
		first = false
		offset += length
		if last {
			return info, offset, nil
		}
	}
}

func parseFLACStreamInfo(block []byte) (flacStreamInfo, error) {
	r := flacBits{data: block}
	field := func(n uint) int { v, _ := r.read(n); return int(v) } // #nosec G115 -- fixed-width fields of at most 20 bits
	info := flacStreamInfo{minBlock: field(16), maxBlock: field(16)}
	field(24) // minimum frame size
	field(24) // maximum frame size
	info.sampleRate = field(20)
	info.channels = field(3) + 1
	info.bitsPerSample = field(5) + 1
	total, _ := r.read(36)
	info.totalSamples = total
	copy(info.md5[:], block[18:34])
	switch {
	case info.sampleRate < 8000 || info.sampleRate > 192000:
		return info, fmt.Errorf("%w: unsupported sample rate %d Hz", ErrCorruptContainer, info.sampleRate)
	case info.channels > 2:
		// Matches the WAV policy: no silent fold-down of multichannel sources.
		return info, fmt.Errorf("%w: invalid channel count %d", ErrCorruptContainer, info.channels)
	case info.bitsPerSample < 4:
		return info, fmt.Errorf("%w: unsupported bit depth %d", ErrCorruptContainer, info.bitsPerSample)
	case info.minBlock < 16 || info.maxBlock < info.minBlock:
		return info, fmt.Errorf("%w: invalid FLAC block sizes", ErrCorruptContainer)
	}
	return info, nil
}

var flacBlockSizes = [16]int{0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768}
var flacRates = [12]int{0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000}
var flacDepths = [8]int{0, 8, 12, 0, 16, 20, 24, 32}

// decodeFLACFrame decodes one frame into out and returns its block size and byte length.
func decodeFLACFrame(data []byte, info flacStreamInfo, out *[flacMaxChannels][]int64) (int, int, error) {
	corrupt := func(what string) (int, int, error) {
		return 0, 0, fmt.Errorf("%w: FLAC frame %s", ErrCorruptContainer, what)
	}
	r := flacBits{data: data}
	sync, _ := r.read(15)
	if sync != 0x7FFC {
		return corrupt("sync")
	}
	r.pos++ // blocking strategy
	sizeCode, _ := r.read(4)
	rateCode, _ := r.read(4)
	assignment, _ := r.read(4)
	depthCode, _ := r.read(3)
	reserved, err := r.read(1)
	if err != nil || reserved != 0 || sizeCode == 0 || rateCode == 15 || depthCode == 3 || assignment > 10 {
		return corrupt("header")
	}
	if err := skipFLACUTF8(&r); err != nil {
		return corrupt("number")
	}
	blockSize := flacBlockSizes[sizeCode]
	switch sizeCode {
	case 6:
		v, err := r.read(8)
		if err != nil {
			return corrupt("block size")
		}
		blockSize = int(v) + 1 // #nosec G115 -- 8-bit field
	case 7:
		v, err := r.read(16)
		if err != nil {
			return corrupt("block size")
		}
		blockSize = int(v) + 1 // #nosec G115 -- 16-bit field
	}
	rate := info.sampleRate
	switch {
	case rateCode >= 1 && rateCode <= 11:
		rate = flacRates[rateCode]
	case rateCode == 12:
		v, err := r.read(8)
		if err != nil {
			return corrupt("sample rate")
		}
		rate = int(v) * 1000 // #nosec G115 -- 8-bit field
	case rateCode == 13 || rateCode == 14:
		v, err := r.read(16)
		if err != nil {
			return corrupt("sample rate")
		}
		rate = int(v) // #nosec G115 -- 16-bit field
		if rateCode == 14 {
			rate *= 10
		}
	}
	depth := info.bitsPerSample
	if depthCode != 0 {
		depth = flacDepths[depthCode]
	}
	channels := int(assignment) + 1 // #nosec G115 -- 4-bit field
	if assignment >= 8 {
		channels = 2
	}
	if rate != info.sampleRate || depth != info.bitsPerSample || channels != info.channels || blockSize > info.maxBlock {
		return corrupt("disagrees with STREAMINFO")
	}
	headerEnd := r.pos >> 3
	crc8, err := r.read(8)
	if err != nil || byte(crc8&0xFF) != flacCRC8(data[:headerEnd]) { // #nosec G115 -- 8-bit field
		return corrupt("header CRC")
	}
	for ch := range channels {
		if cap(out[ch]) < blockSize {
			out[ch] = make([]int64, blockSize)
		}
		out[ch] = out[ch][:blockSize]
		width := uint(depth) // #nosec G115 -- depth <= 32
		if (assignment == 8 && ch == 1) || (assignment == 9 && ch == 0) || (assignment == 10 && ch == 1) {
			width++ // side channel carries one extra bit
		}
		if err := decodeFLACSubframe(&r, width, out[ch]); err != nil {
			return corrupt("subframe: " + err.Error())
		}
	}
	r.align()
	end := r.pos >> 3
	if end+2 > len(data) || binary.BigEndian.Uint16(data[end:end+2]) != flacCRC16(data[:end]) {
		return corrupt("CRC")
	}
	left, right := out[0], out[1]
	switch assignment {
	case 8: // left/side
		for i := range blockSize {
			right[i] = left[i] - right[i]
		}
	case 9: // side/right
		for i := range blockSize {
			left[i] += right[i]
		}
	case 10: // mid/side
		for i := range blockSize {
			mid := left[i]<<1 | (right[i] & 1)
			left[i] = (mid + right[i]) >> 1
			right[i] = (mid - right[i]) >> 1
		}
	}
	return blockSize, end + 2, nil
}

func skipFLACUTF8(r *flacBits) error {
	lead, err := r.read(8)
	if err != nil {
		return err
	}
	extra := bits.LeadingZeros8(^byte(lead & 0xFF)) // #nosec G115 -- 8-bit field
	if extra == 1 || extra > 7 {
		return errFLACBits
	}
	for i := 1; i < extra; i++ {
		b, err := r.read(8)
		if err != nil || b&0xC0 != 0x80 {
			return errFLACBits
		}
	}
	return nil
}

func decodeFLACSubframe(r *flacBits, width uint, out []int64) error {
	header, err := r.read(8)
	if err != nil {
		return err
	}
	if header&0x80 != 0 {
		return errors.New("reserved bit")
	}
	kind := (header >> 1) & 0x3F
	var wasted uint
	if header&1 != 0 {
		n, err := r.unary()
		if err != nil {
			return err
		}
		wasted = uint(n) + 1 // #nosec G115 -- bounded below
		if wasted >= width {
			return errors.New("wasted bits")
		}
		width -= wasted
	}
	switch {
	case kind == 0:
		v, err := r.signed(width)
		if err != nil {
			return err
		}
		for i := range out {
			out[i] = v
		}
	case kind == 1:
		for i := range out {
			if out[i], err = r.signed(width); err != nil {
				return err
			}
		}
	case kind >= 8 && kind <= 12:
		if err := decodeFLACFixed(r, width, int(kind-8), out); err != nil { // #nosec G115 -- order 0..4
			return err
		}
	case kind >= 32:
		if err := decodeFLACLPC(r, width, int(kind-31), out); err != nil { // #nosec G115 -- order 1..32
			return err
		}
	default:
		return errors.New("reserved subframe type")
	}
	if wasted > 0 {
		for i := range out {
			out[i] <<= wasted
		}
	}
	return nil
}

func decodeFLACFixed(r *flacBits, width uint, order int, out []int64) error {
	if order > len(out) {
		return errors.New("predictor order exceeds block")
	}
	for i := range order {
		v, err := r.signed(width)
		if err != nil {
			return err
		}
		out[i] = v
	}
	if err := decodeFLACResidual(r, order, out); err != nil {
		return err
	}
	for i := order; i < len(out); i++ {
		switch order {
		case 1:
			out[i] += out[i-1]
		case 2:
			out[i] += 2*out[i-1] - out[i-2]
		case 3:
			out[i] += 3*out[i-1] - 3*out[i-2] + out[i-3]
		case 4:
			out[i] += 4*out[i-1] - 6*out[i-2] + 4*out[i-3] - out[i-4]
		}
	}
	return nil
}

func decodeFLACLPC(r *flacBits, width uint, order int, out []int64) error {
	if order > len(out) {
		return errors.New("predictor order exceeds block")
	}
	for i := range order {
		v, err := r.signed(width)
		if err != nil {
			return err
		}
		out[i] = v
	}
	precision, err := r.read(4)
	if err != nil || precision == 15 {
		return errors.New("invalid LPC precision")
	}
	shift, err := r.signed(5)
	if err != nil || shift < 0 {
		return errors.New("invalid LPC shift")
	}
	var coeffs [32]int64
	for i := range order {
		if coeffs[i], err = r.signed(uint(precision) + 1); err != nil {
			return err
		}
	}
	if err := decodeFLACResidual(r, order, out); err != nil {
		return err
	}
	for i := order; i < len(out); i++ {
		var sum int64
		for j := range order {
			sum += coeffs[j] * out[i-1-j]
		}
		out[i] += sum >> uint(shift) // #nosec G115 -- shift is 0..15
	}
	return nil
}

// decodeFLACResidual writes Rice-coded residuals into out[order:].
func decodeFLACResidual(r *flacBits, order int, out []int64) error {
	method, err := r.read(2)
	if err != nil || method > 1 {
		return errors.New("invalid residual coding method")
	}
	paramBits, escape := uint(4), uint64(15)
	if method == 1 {
		paramBits, escape = 5, 31
	}
	partitionOrder, err := r.read(4)
	if err != nil {
		return err
	}
	partitions := 1 << partitionOrder
	if len(out)%partitions != 0 {
		return errors.New("invalid partition order")
	}
	perPartition := len(out) / partitions
	if perPartition < order {
		return errors.New("invalid partition order")
	}
	i := order
	for p := range partitions {
		count := perPartition
		if p == 0 {
			count -= order
		}
		param, err := r.read(paramBits)
		if err != nil {
			return err
		}
		if param == escape {
			raw, err := r.read(5)
			if err != nil {
				return err
			}
			for range count {
				if out[i], err = r.signed(uint(raw)); err != nil {
					return err
				}
				i++
			}
			continue
		}
		k := uint(param)
		for range count {
			q, err := r.unary()
			if err != nil {
				return err
			}
			if q > 1<<32 {
				return errors.New("residual overflow")
			}
			low, err := r.read(k)
			if err != nil {
				return err
			}
			u := q<<k | low
			out[i] = int64(u>>1) ^ -int64(u&1) // #nosec G115 -- zigzag decoding
			i++
		}
	}
	return nil
}

var flacCRC8Table, flacCRC16Table = func() ([256]byte, [256]uint16) {
	var t8 [256]byte
	var t16 [256]uint16
	for i := range 256 {
		c8 := byte(i)         // #nosec G115 -- 0..255
		c16 := uint16(i) << 8 // #nosec G115 -- 0..255
		for range 8 {
			if c8&0x80 != 0 {
				c8 = c8<<1 ^ 0x07
			} else {
				c8 <<= 1
			}
			if c16&0x8000 != 0 {
				c16 = c16<<1 ^ 0x8005
			} else {
				c16 <<= 1
			}
		}
		t8[i], t16[i] = c8, c16
	}
	return t8, t16
}()

func flacCRC8(data []byte) byte {
	var crc byte
	for _, b := range data {
		crc = flacCRC8Table[crc^b]
	}
	return crc
}

func flacCRC16(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc = crc<<8 ^ flacCRC16Table[byte(crc>>8)^b]
	}
	return crc
}
