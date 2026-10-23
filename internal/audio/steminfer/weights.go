package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"sort"
	"unicode/utf8"
)

// The recovered container selects byte-identical original F16 tensors; see the
// development recovery script and NOTICE for the preserved historical pin.
const modelBytes = 176487688
const modelSHA256 = "0d51845078d4c075d825ba18f776f9af96e50d34d3491102a1215b6dbaf684b7"
const maximumHeaderBytes = 1024 * 1024
const maximumTensorElements = 1024 * 1024

type tensorShape []int
type tensorDescriptor struct {
	shape      tensorShape
	start, end int
}
type weightArchive struct {
	data    []byte
	tensors map[string]tensorDescriptor
}

// readArchive validates the closed expected schema before retaining immutable
// bytes. Neither an arbitrary tensor name nor a claimed shape drives allocation.
func readArchive(ctx context.Context, source io.ReaderAt, size int, schema map[string]tensorShape, digest string) (*weightArchive, error) {
	if ctx == nil || source == nil || size < 10 || size > modelBytes || len(schema) < 1 || len(schema) > 1691 {
		return nil, errors.New("invalid bounded weights source")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var prefix [8]byte
	if _, err := source.ReadAt(prefix[:], 0); err != nil {
		return nil, fmt.Errorf("weights prefix: %w", err)
	}
	headerLength := binary.LittleEndian.Uint64(prefix[:])
	if headerLength < 2 || headerLength > maximumHeaderBytes || headerLength > uint64(size-8) {
		return nil, errors.New("invalid weights header bound")
	}
	header := make([]byte, int(headerLength))
	if _, err := source.ReadAt(header, 8); err != nil {
		return nil, fmt.Errorf("weights header: %w", err)
	}
	descriptors, err := parseWeightHeader(header, schema, size-8-int(headerLength))
	if err != nil {
		return nil, err
	}
	expected, err := hex.DecodeString(digest)
	if err != nil || len(expected) != sha256.Size {
		return nil, errors.New("invalid expected weights digest")
	}
	data := make([]byte, size)
	hash := sha256.New()
	for start := 0; start < size; start += 32768 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+32768, size)
		if _, err := source.ReadAt(data[start:end], int64(start)); err != nil {
			return nil, fmt.Errorf("weights data: %w", err)
		}
		_, _ = hash.Write(data[start:end])
	}
	if !bytes.Equal(hash.Sum(nil), expected) {
		return nil, errors.New("weights checksum mismatch")
	}
	dataStart := 8 + int(headerLength)
	if !bytes.Equal(data[:8], prefix[:]) || !bytes.Equal(data[8:dataStart], header) {
		return nil, errors.New("weights source changed during validation")
	}
	for i := dataStart; i < size; i += 2 {
		if i%32768 == dataStart%32768 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if binary.LittleEndian.Uint16(data[i:i+2])&0x7c00 == 0x7c00 {
			return nil, errors.New("non-finite model weight")
		}
	}
	for name, descriptor := range descriptors {
		descriptor.start += dataStart
		descriptor.end += dataStart
		descriptors[name] = descriptor
	}
	return &weightArchive{data: data, tensors: descriptors}, nil
}

func parseWeightHeader(data []byte, schema map[string]tensorShape, dataBytes int) (map[string]tensorDescriptor, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("weights header must be valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errors.New("weights object required")
	}
	descriptors := make(map[string]tensorDescriptor, len(schema))
	seen := make(map[string]bool, len(schema)+1)
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || len(name) < 1 || len(name) > 160 || seen[name] || len(seen) > len(schema) {
			return nil, errors.New("invalid duplicate or excessive weights entry")
		}
		seen[name] = true
		if name == "__metadata__" {
			if err := readWeightMetadata(decoder); err != nil {
				return nil, err
			}
			continue
		}
		expected, exists := schema[name]
		if !exists {
			return nil, errors.New("unexpected model tensor")
		}
		descriptor, err := readWeightDescriptor(decoder)
		if err != nil {
			return nil, err
		}
		if !slices.Equal(descriptor.shape, expected) || descriptor.end > dataBytes {
			return nil, errors.New("model tensor shape or offset mismatch")
		}
		descriptors[name] = descriptor
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing weights header data")
	}
	if len(descriptors) != len(schema) {
		return nil, errors.New("missing model tensors")
	}
	ordered := make([]tensorDescriptor, 0, len(descriptors))
	for _, descriptor := range descriptors {
		ordered = append(ordered, descriptor)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].start < ordered[j].start })
	end := 0
	for _, descriptor := range ordered {
		if descriptor.start != end {
			return nil, errors.New("overlapping or gapped tensor data")
		}
		end = descriptor.end
	}
	if end != dataBytes {
		return nil, errors.New("trailing or truncated tensor data")
	}
	return descriptors, nil
}
func readWeightMetadata(decoder *json.Decoder) error {
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return errors.New("weights metadata object required")
	}
	seen := map[string]bool{}
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || len(name) > 160 || seen[name] || len(seen) >= 16 {
			return errors.New("invalid weights metadata")
		}
		seen[name] = true
		var value string
		if err := decoder.Decode(&value); err != nil || len(value) > 4096 {
			return errors.New("invalid weights metadata value")
		}
	}
	_, err = decoder.Token()
	return err
}
func readWeightDescriptor(decoder *json.Decoder) (tensorDescriptor, error) {
	var result tensorDescriptor
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return result, errors.New("weights descriptor object required")
	}
	seen := map[string]bool{}
	var dtype string
	var shape, offsets []int
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return result, errors.New("duplicate tensor descriptor field")
		}
		seen[name] = true
		switch name {
		case "dtype":
			err = decoder.Decode(&dtype)
		case "shape":
			shape, err = readWeightDimensions(decoder)
		case "data_offsets":
			offsets, err = readWeightDimensions(decoder)
		default:
			return result, errors.New("unknown tensor descriptor field")
		}
		if err != nil {
			return result, err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return result, err
	}
	if len(seen) != 3 || dtype != "F16" || len(shape) < 1 || len(shape) > 2 || len(offsets) != 2 {
		return result, errors.New("unsupported model dtype or tensor rank")
	}
	elements := 1
	for _, dimension := range shape {
		if dimension < 1 || dimension > matrixLimit || elements > maximumTensorElements/dimension {
			return result, errors.New("tensor dimensions exceed bound")
		}
		elements *= dimension
	}
	if offsets[0] < 0 || offsets[1] < offsets[0] || offsets[1]-offsets[0] != 2*elements {
		return result, errors.New("invalid tensor byte range")
	}
	result.shape, result.start, result.end = shape, offsets[0], offsets[1]
	return result, nil
}
func (archive *weightArchive) tensorInto(name string, destination []float32) error {
	descriptor, found := archive.tensors[name]
	if !found || len(destination) != (descriptor.end-descriptor.start)/2 {
		return errors.New("invalid model tensor destination")
	}
	for i := range destination {
		destination[i] = widenHalf(binary.LittleEndian.Uint16(archive.data[descriptor.start+2*i : descriptor.start+2*i+2]))
	}
	return nil
}
func widenHalf(value uint16) float32 {
	sign := uint32(value&0x8000) << 16
	exponent := uint32(value>>10) & 31
	fraction := uint32(value & 1023)
	switch exponent {
	case 0:
		if fraction == 0 {
			return math.Float32frombits(sign)
		}
		exponent = 113
		for fraction&1024 == 0 {
			fraction <<= 1
			exponent--
		}
		fraction &= 1023
	case 31:
		exponent = 255
	default:
		exponent += 112
	}
	return math.Float32frombits(sign | exponent<<23 | fraction<<13)
}

func readWeightDimensions(decoder *json.Decoder) ([]int, error) {
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('[') {
		return nil, errors.New("tensor integer array required")
	}
	var result []int
	for decoder.More() {
		if len(result) >= 2 {
			return nil, errors.New("tensor array exceeds bound")
		}
		var value int
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	_, err = decoder.Token()
	return result, err
}
