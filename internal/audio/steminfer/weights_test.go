package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"os"
	"strings"
	"testing"
)

func weightFixture(header string, values ...uint16) []byte {
	for len(header)%8 != 0 {
		header += " "
	}
	data := make([]byte, 8+len(header)+2*len(values))
	binary.LittleEndian.PutUint64(data[:8], uint64(len(header)))
	copy(data[8:], header)
	for i, value := range values {
		binary.LittleEndian.PutUint16(data[8+len(header)+i*2:], value)
	}
	return data
}
func archiveDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
func TestStrictWeightsValidFiniteImmutableAndChecksum(t *testing.T) {
	data := weightFixture(`{"a":{"dtype":"F16","shape":[2,2],"data_offsets":[0,8]}}`, 0x3c00, 0xc000, 0, 1)
	schema := map[string]tensorShape{"a": {2, 2}}
	archive, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, archiveDigest(data))
	if err != nil {
		t.Fatal(err)
	}
	for i := range data {
		data[i] = 0
	}
	destination := make([]float32, 4)
	if err := archive.tensorInto("a", destination); err != nil {
		t.Fatal(err)
	}
	for i, want := range []float32{1, -2, 0, 0x1p-24} {
		if destination[i] != want {
			t.Fatal("f16 conversion changed", i, destination[i], want)
		}
	}
	if err := archive.tensorInto("missing", destination); err == nil {
		t.Fatal("unbound tensor accepted")
	}
	data = weightFixture(`{"a":{"dtype":"F16","shape":[2,2],"data_offsets":[0,8]}}`, 0x3c00, 0xc000, 0, 1)
	if _, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, strings.Repeat("0", 64)); err == nil {
		t.Fatal("checksum mismatch accepted")
	}
}
func TestStrictWeightsRejectHostileDescriptorsAndNonFinite(t *testing.T) {
	schema := map[string]tensorShape{"a": {2}}
	headers := []string{
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]},"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","dtype":"F16","shape":[2],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F32","shape":[2],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","shape":[0],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","shape":[2,1,1],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4,4]}}`,
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[2,6]}}`,
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,2]}}`,
		`{"a":{"dtype":"F16","shape":null,"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4],"extra":1}}`,
		`{"b":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}`,
		`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}} {}`,
		`{"__metadata__":{"a":"one","a":"two"},"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}`,
		"{\"__metadata__\":{\"a\":\"\xff\"},\"a\":{\"dtype\":\"F16\",\"shape\":[2],\"data_offsets\":[0,4]}}",
	}
	for i, header := range headers {
		data := weightFixture(header, 0, 0)
		if _, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, archiveDigest(data)); err == nil {
			t.Fatalf("hostile descriptor%d accepted", i)
		}
	}
	for _, value := range []uint16{0x7c00, 0xfc00, 0x7c01, 0x7fff} {
		data := weightFixture(`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}`, 0, value)
		if _, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, archiveDigest(data)); err == nil {
			t.Fatal("non-finite weight accepted", value)
		}
	}
	data := weightFixture(`{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}`, 0, 0, 0)
	if _, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, archiveDigest(data)); err == nil {
		t.Fatal("trailing payload accepted")
	}
	binary.LittleEndian.PutUint64(data[:8], math.MaxUint64)
	if _, err := readArchive(context.Background(), bytes.NewReader(data), len(data), schema, archiveDigest(data)); err == nil {
		t.Fatal("huge header accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := readArchive(ctx, bytes.NewReader(data), len(data), schema, archiveDigest(data)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored", err)
	}
}

type changingWeightReader struct{ whole, header []byte }

func (reader changingWeightReader) ReadAt(output []byte, offset int64) (int, error) {
	if offset == 8 && len(output) == len(reader.header) {
		return copy(output, reader.header), nil
	}
	return bytes.NewReader(reader.whole).ReadAt(output, offset)
}
func TestStrictWeightsRejectReaderHeaderRace(t *testing.T) {
	genuine := weightFixture(`{"a":{"dtype":"F16","shape":[1],"data_offsets":[0,2]},"b":{"dtype":"F16","shape":[1],"data_offsets":[2,4]}}`, 0, 0x3c00)
	changed := weightFixture(`{"a":{"dtype":"F16","shape":[1],"data_offsets":[2,4]},"b":{"dtype":"F16","shape":[1],"data_offsets":[0,2]}}`, 0, 0x3c00)
	size := len(changed) - 12
	reader := changingWeightReader{whole: genuine, header: changed[8 : 8+size]}
	if _, err := readArchive(context.Background(), reader, len(genuine), map[string]tensorShape{"a": {1}, "b": {1}}, archiveDigest(genuine)); err == nil {
		t.Fatal("mutable source changed tensor names after successful checksum")
	}
}
func TestHalfFiniteDomainAgainstArithmeticOracle(t *testing.T) {
	for bits := range 65536 {
		value := uint16(bits)
		exponent, fraction := int(value>>10)&31, int(value&1023)
		if exponent == 31 {
			continue
		}
		want := math.Ldexp(float64(fraction), -24)
		if exponent != 0 {
			want = math.Ldexp(1+float64(fraction)/1024, exponent-15)
		}
		if value&0x8000 != 0 {
			want = math.Copysign(want, -1)
		}
		if math.Float32bits(widenHalf(value)) != math.Float32bits(float32(want)) {
			t.Fatal("half precision mismatch", bits)
		}
	}
}
func TestPinnedModelSchema(t *testing.T) {
	schema := expectedModelSchema()
	elements, bins := 0, 0
	for _, shape := range schema {
		product := 1
		for _, dimension := range shape {
			product *= dimension
		}
		elements += product
	}
	for _, count := range bandBins {
		bins += count
	}
	if len(schema) != 1691 || elements != 88152812 || bins != spectrumBins || featureCount != 4100 || maximumSequence != 1723 {
		t.Fatal("model layout drift", len(schema), elements, bins)
	}
}
func TestReadActualPinnedModel(t *testing.T) {
	path := os.Getenv("AURIALIS_STEM_MODEL")
	if path == "" {
		t.Skip("set the trusted development model path")
	}
	// #nosec G304 G703 -- Opt-in local development model artifact, never a request or upload path.
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.Size() != modelBytes {
		t.Fatal("unexpected development model size", err)
	}
	archive, err := readArchive(context.Background(), io.NewSectionReader(file, 0, modelBytes), modelBytes, expectedModelSchema(), modelSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.tensors) != 1691 {
		t.Fatal("pinned model tensors omitted")
	}
}
