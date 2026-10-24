package steminfer

// cspell:words steminfer AURAGO softmax VECLIB BLAS

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"testing"
	"time"
)

const attentionFixtureOutputCap = 64 * 1024 * 1024

type attentionFixtureCase struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	M      int    `json:"m"`
	N      int    `json:"n"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func attentionFixtureCases() []attentionFixtureCase {
	cases := make([]attentionFixtureCase, 0, 28)
	add := func(kind string, m, n int) {
		cases = append(cases, attentionFixtureCase{Name: fmt.Sprintf("%s-m%d-n%d.go.bin", kind, m, n), Kind: kind, M: m, N: n})
	}
	for _, n := range []int{1, 15, 16, 17, 63, 64, 65, 255, 256, 257, 1723} {
		m := 1
		if n == 17 || n == 65 {
			m = 3
		}
		if n == 1723 {
			m = 8
		}
		add("pattern", m, n)
	}
	for _, n := range []int{1, 16, 17, 64, 65, 256, 257, 1723} {
		add("last-key-dominant", 1, n)
	}
	for _, kind := range []string{"zero", "ties", "cancellation", "high-dynamic", "rounding-boundary"} {
		add(kind, 3, 65)
	}
	add("subnormal-input", 1, 2)
	add("ftz-resurrection", 1, 2)
	add("pv-cancellation", 1, 1723)
	add("normal-exp-boundary", 1, 2)
	return cases
}

func attentionFixtureInputs(item attentionFixtureCase) (q, k, v []float32) {
	q, k, v = make([]float32, item.M*64), make([]float32, item.N*64), make([]float32, item.N*64)
	for side, values := range [][]float32{q, k, v} {
		for i := range values {
			values[i] = float32((i*(side*4+3))%31-15) / 16
		}
	}
	switch item.Kind {
	case "zero":
		clear(q)
		clear(k)
		clear(v)
		for i := 1; i < len(q); i += 2 {
			q[i] = float32(math.Copysign(0, -1))
		}
	case "ties":
		for i := range q {
			q[i] = .125
		}
		for i := range k {
			k[i] = .25
		}
	case "last-key-dominant":
		clear(q)
		clear(k)
		clear(v)
		q[0] = 8
		k[(item.N-1)*64] = 8
		for i := (item.N - 1) * 64; i < len(v); i++ {
			v[i] = 32
		}
	case "cancellation":
		for i := range q {
			q[i] = 16
			if i%2 == 1 {
				q[i] = -16
			}
		}
		for i := range k {
			k[i] = 1
		}
		k[len(k)-1] = float32(1 + math.Ldexp(1, -23))
	case "high-dynamic":
		for i := range q {
			q[i] = [...]float32{16, -16, 1e-15, -1e-15}[i%4]
		}
		for i := range k {
			k[i] = [...]float32{1e-15, 1e-15, 16, -16}[i%4]
		}
	case "rounding-boundary":
		clear(q)
		clear(k)
		for row := range item.M {
			q[row*64] = 1
			q[row*64+1] = 1
		}
		for row := range item.N {
			k[row*64] = 1
			k[row*64+1] = float32(math.Ldexp(1, -24))
			if row%2 == 1 {
				k[row*64+1] = -k[row*64+1]
			}
		}
	case "subnormal-input":
		clear(q)
		clear(k)
		q[0] = float32(math.Ldexp(1, -140))
		k[0] = 16
	case "ftz-resurrection", "normal-exp-boundary":
		clear(q)
		clear(k)
		clear(v)
		for i := range 4 {
			q[i] = 16
			k[64+i] = -10.9375
		}
		if item.Kind == "normal-exp-boundary" {
			k[64] = -10.85577392578125
		}
		for i := 64; i < len(v); i++ {
			v[i] = 32
		}
	case "pv-cancellation":
		clear(q)
		clear(k)
		for row := range item.N {
			for column := range 64 {
				v[row*64+column] = 32
				if row%2 == 1 {
					v[row*64+column] = -32
				}
			}
		}
	}
	return q, k, v
}

func actualAttentionFixture(ctx context.Context, item attentionFixtureCase) ([]byte, error) {
	if item.M < 1 || item.M > 8 || item.N < 1 || item.N > 1723 {
		return nil, errors.New("unsafe attention fixture geometry")
	}
	q, k, v := attentionFixtureInputs(item)
	raw := make([]float32, item.M*item.N)
	if err := multiply(ctx, raw, q, k, item.M, item.N, 64, true); err != nil {
		return nil, err
	}
	probability := append([]float32{}, raw...)
	if err := attentionSoftmax(ctx, probability, item.M, item.N); err != nil {
		return nil, err
	}
	output := make([]float32, item.M*64)
	if err := multiply(ctx, output, probability, v, item.M, 64, item.N, false); err != nil {
		return nil, err
	}
	data := []byte("AURAGO01")
	for _, word := range []uint32{uint32(item.M), uint32(item.N), 64, 0} {
		data = binary.LittleEndian.AppendUint32(data, word)
	}
	for _, values := range [][]float32{q, k, v, raw, probability, output} {
		for _, value := range values {
			if !finite32(value) {
				return nil, errors.New("nonfinite actual Go attention trace")
			}
			data = binary.LittleEndian.AppendUint32(data, math.Float32bits(value))
		}
	}
	return data, nil
}

// TestWriteAttentionFixtures exports the actual native endpoint, not an imitation
// of its fused softmax internals. It loads no audio, model or weights.
func TestWriteAttentionFixtures(t *testing.T) {
	directory := os.Getenv("AURIALIS_ATTENTION_FIXTURE_DIR")
	if directory == "" {
		t.Skip("set the explicit fresh private attention fixture directory")
	}
	if runtime.GOMAXPROCS(0) != 1 || os.Getenv("VECLIB_MAXIMUM_THREADS") != "1" {
		t.Fatal("producer requires GOMAXPROCS=1 and VECLIB_MAXIMUM_THREADS=1 before startup")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
	defer cancel()
	// #nosec G703 -- Explicit developer-owned fresh fixture directory, never a request path.
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	files, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	records := attentionFixtureCases()
	if len(records) > 32 {
		t.Fatal("preregistered fixture count exceeds32")
	}
	total := 0
	for i, item := range records {
		if err := ctx.Err(); err != nil {
			t.Fatal(err)
		}
		data, err := actualAttentionFixture(ctx, item)
		if err != nil {
			t.Fatal(err)
		}
		total += len(data)
		if total > attentionFixtureOutputCap-65536 {
			t.Fatal("private producer output exceeds64MiB")
		}
		if err := files.WriteFile(item.Name, data, 0o600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		records[i].Bytes = len(data)
		records[i].SHA256 = hex.EncodeToString(digest[:])
	}
	metadata, err := json.MarshalIndent(struct {
		Format        string                 `json:"format"`
		Scope         string                 `json:"scope"`
		Backend       string                 `json:"backend"`
		ThreadPolicy  string                 `json:"threadPolicy"`
		ModelForwards int                    `json:"modelForwards"`
		Cases         []attentionFixtureCase `json:"cases"`
	}{"aurialis-private-attention-go-1", "actual multiply/attentionSoftmax/multiply; synthetic post-RoPE inputs; no fused internal trace claim", matrixBackendName(), "GOMAXPROCS=1; VECLIB_MAXIMUM_THREADS=1 configured, opaque BLAS worker count not observed", 0, records}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := files.WriteFile("manifest.json", append(metadata, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("exported %d closed actual Go attention endpoints (%d bytes), no model/audio/GPU", len(records), total)
}

func TestAttentionFixtureRegistry(t *testing.T) {
	cases := attentionFixtureCases()
	if len(cases) != 28 {
		t.Fatalf("registry must stay closed at28, got%d", len(cases))
	}
	seen := make(map[string]bool)
	for _, item := range cases {
		if seen[item.Name] || item.M < 1 || item.M > 8 || item.N < 1 || item.N > 1723 {
			t.Fatal("unsafe or duplicate attention fixture")
		}
		seen[item.Name] = true
		q, k, v := attentionFixtureInputs(item)
		if len(q) != item.M*64 || len(k) != item.N*64 || len(v) != item.N*64 {
			t.Fatal("fixture geometry")
		}
		for _, values := range [][]float32{q, k, v} {
			for _, value := range values {
				if !finite32(value) || math.Abs(float64(value)) > 32 {
					t.Fatal("unsafe fixture operand")
				}
			}
		}
	}
	item := attentionFixtureCase{Kind: "ftz-resurrection", M: 1, N: 2}
	q, k, _ := attentionFixtureInputs(item)
	var raw float64
	for i := range 64 {
		raw += float64(q[i]) * float64(k[64+i])
	}
	exponential := float32(math.Exp(raw * .125))
	output := float32(exponential * 32)
	if raw != -700 || exponential <= 0 || exponential >= float32(math.Ldexp(1, -126)) || output < float32(math.Ldexp(1, -126)) {
		t.Fatal("mandatory FTZ resurrection counterexample changed")
	}
}
