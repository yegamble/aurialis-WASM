package steminfer

// cspell:words steminfer AURNGO RMSNorm

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
)

const normTraceBinarySHA256 = "7d19cda2550f930cd860883beb926606d7763b57493172e36ba31dc2143520d4"

type normFixtureRecord struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Rows      int    `json:"rows"`
	Gamma     string `json:"gamma"`
	Admission string `json:"admission"`
	Bytes     int    `json:"bytes"`
	SHA256    string `json:"sha256"`
}

func syntheticNormInput(rows int, kind string) []float32 {
	values := make([]float32, rows*256)
	for index := range values {
		value := float32(index%31-15) / 16
		switch kind {
		case "zero":
			value = 0
			if index%2 == 1 {
				value = float32(math.Copysign(0, -1))
			}
		case "constant":
			value = 0.25
		case "alternating":
			value = 1
			if index%2 == 1 {
				value = -1
			}
		case "clamp-below", "clamp-above", "clamp-near-below", "clamp-near-above":
			factor := 0.5
			switch kind {
			case "clamp-above":
				factor = 2
			case "clamp-near-below":
				factor = 1 - math.Ldexp(1, -21)
			case "clamp-near-above":
				factor = 1 + math.Ldexp(1, -21)
			}
			value = float32(1e-12 / 16 * factor)
			if index%2 == 1 {
				value = -value
			}
		case "dynamic":
			value = [...]float32{1e15, -1e15, 1e-15, -1e-15, 1, -1, 0.01, -0.01}[index%8]
		case "tiny-normal":
			value *= 1e-30
		case "subnormal-input":
			value = 1e-40
			if index%2 == 1 {
				value = -value
			}
		case "quotient-underflow":
			value = 0
			if index%256 == 0 {
				value = float32(math.Ldexp(1, -103))
			} else if index%256 == 1 {
				value = float32(3 * math.Ldexp(1, 30))
			}
		case "reassociation-underflow":
			value = 0
			if index%256 == 0 {
				value = float32(math.Ldexp(1, -30))
			}
		case "scale-reassociation-underflow":
			value = 0
			if index%256 == 0 {
				value = 0.125
			} else if index%256 == 1 {
				value = 1
			}
		case "overflow-reject":
			value = 1e30
		}
		values[index] = value
	}
	return values
}

// TestWriteOriginalNormalizationFixtures calls the actual Go normalization and
// exports bounded input/output traces. It never runs a neural forward pass.
func TestWriteOriginalNormalizationFixtures(t *testing.T) {
	directory := os.Getenv("AURIALIS_NORM_FIXTURE_DIR")
	if directory == "" {
		t.Skip("set the explicit private normalization fixture directory")
	}
	archive := actualArchive(t)
	gamma := make([]float32, 256)
	const gammaName = "layers.0.0.layers.0.0.norm.gamma"
	if err := archive.tensorInto(gammaName, gamma); err != nil {
		t.Fatal(err)
	}
	traceDirectory := os.Getenv("AURIALIS_NORM_ORIGINAL_TRACE")
	raw, err := boundedTestArtifact(filepath.Join(traceDirectory, "oracle.bin"), 64*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != normTraceBinarySHA256 {
		t.Fatal("original broadband trace checksum mismatch")
	}
	// Pinned original oracle: band_split[62,5,256], before layer0.time norm.
	const traceOffset, traceRows = 106616, 310
	if traceOffset+traceRows*256*4 > len(raw) {
		t.Fatal("original trace geometry changed")
	}
	trace := make([]float32, traceRows*256)
	for index := range trace {
		start := traceOffset + index*4
		trace[index] = math.Float32frombits(binary.LittleEndian.Uint32(raw[start : start+4]))
		if !finite32(trace[index]) {
			t.Fatal("nonfinite original trace")
		}
	}
	// #nosec G703 -- Explicit developer-owned fresh fixture directory, never a request path.
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	files, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	var records []normFixtureRecord
	write := func(rows int, kind string, input []float32) {
		t.Helper()
		if rows < 1 || rows > 512 || len(input) != rows*256 {
			t.Fatal("unsafe normalization fixture geometry")
			return
		}
		gain := append([]float32{}, gamma...)
		gainName := gammaName
		if kind == "subnormal-gamma" {
			gainName = "synthetic-subnormal-gamma"
			for index := range gain {
				gain[index] = 1e-40
				if index%2 == 1 {
					gain[index] = -gain[index]
				}
			}
		}
		if kind == "quotient-underflow" || kind == "reassociation-underflow" || kind == "scale-reassociation-underflow" {
			gainName = "synthetic-" + kind + "-gamma"
			for index := range gain {
				gain[index] = 32
				if kind == "reassociation-underflow" || kind == "scale-reassociation-underflow" {
					gain[index] = float32(math.Ldexp(1, -126))
				}
			}
		}
		output := make([]float32, len(input))
		normalizeRows(output, input, gain, rows, 256)
		data := []byte("AURNGO01")
		for _, word := range []uint32{uint32(rows), 256, 0, 0} {
			data = binary.LittleEndian.AppendUint32(data, word)
		}
		for _, values := range [][]float32{input, gain, output} {
			for _, value := range values {
				if !finite32(value) {
					t.Fatal("nonfinite Go normalization fixture")
				}
				data = binary.LittleEndian.AppendUint32(data, math.Float32bits(value))
			}
		}
		for row := range rows {
			var sum float64
			for _, value := range input[row*256 : (row+1)*256] {
				sum += float64(value) * float64(value)
			}
			data = binary.LittleEndian.AppendUint64(data, math.Float64bits(math.Sqrt(sum)))
		}
		name := fmt.Sprintf("%s-r%d.go.bin", kind, rows)
		if err := files.WriteFile(name, data, 0o600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(data)
		admission := "admit"
		if kind == "overflow-reject" {
			admission = "reject-before-worker"
		}
		records = append(records, normFixtureRecord{Name: name, Kind: kind, Rows: rows, Gamma: gainName, Admission: admission, Bytes: len(data), SHA256: hex.EncodeToString(hash[:])})
	}
	for _, rows := range []int{1, 3, 63, 64, 65, 255, 256, 257, 310} {
		write(rows, "actual-band-split", trace[:rows*256])
	}
	for _, rows := range []int{1, 3, 63, 64, 65, 255, 256, 257} {
		write(rows, "pattern", syntheticNormInput(rows, "pattern"))
	}
	for _, kind := range []string{"zero", "constant", "alternating", "clamp-below", "clamp-above", "clamp-near-below", "clamp-near-above", "dynamic", "tiny-normal", "subnormal-input", "subnormal-gamma", "quotient-underflow", "reassociation-underflow", "scale-reassociation-underflow", "overflow-reject"} {
		write(3, kind, syntheticNormInput(3, kind))
	}
	metadata, err := json.MarshalIndent(struct {
		Format              string              `json:"format"`
		ModelSHA256         string              `json:"modelSHA256"`
		OriginalTraceSHA256 string              `json:"originalTraceSHA256"`
		Cases               []normFixtureRecord `json:"cases"`
	}{"aurialis-private-norm-go-1", modelSHA256, normTraceBinarySHA256, records}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := files.WriteFile("manifest.json", append(metadata, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("exported %d actual Go L2*sqrt256 normalization traces without model inference", len(records))
}
