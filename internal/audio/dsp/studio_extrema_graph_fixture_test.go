package dsp

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

// cspell:ignore AUEXTF -- private binary fixture magic
const (
	studioExtremaFixtureFrames = 200000
	studioExtremaFixtureWords  = 16 * 1024 * 1024
	studioExtremaFixtureBytes  = 8 * 1024 * 1024
)

// This bounded, opt-in qualification recorder never runs in an audio callback.
// Outputs contain numeric values only, never addresses or Go struct padding.
// Source/parameter metadata is separate from numeric state serialization.
type studioExtremaRecorder struct {
	t                    *testing.T
	out                  *bufio.Writer
	input                hash.Hash
	bytes, frames, words int
	raw                  [16]byte
}

func (w *studioExtremaRecorder) write(data []byte) {
	if len(data) > studioExtremaFixtureBytes-w.bytes {
		w.t.Fatal("private fixture output admission exceeded")
	}
	n, err := w.out.Write(data)
	if err != nil || n != len(data) {
		w.t.Fatalf("private fixture write: bytes%d error%v", n, err)
	}
	w.bytes += n
}

func (w *studioExtremaRecorder) number(value uint64) {
	binary.LittleEndian.PutUint64(w.raw[:8], value)
	w.write(w.raw[:8])
}

func (w *studioExtremaRecorder) blob(data []byte) {
	w.number(uint64(len(data)))
	w.write(data)
}

func (w *studioExtremaRecorder) pcm(left, right []float32, input bool) {
	if len(left) != len(right) {
		w.t.Fatal("private fixture stereo layout changed")
	}
	w.number(uint64(len(left)))
	for i, value := range left {
		binary.LittleEndian.PutUint32(w.raw[:4], math.Float32bits(value))
		binary.LittleEndian.PutUint32(w.raw[4:8], math.Float32bits(right[i]))
		w.write(w.raw[:8])
		if input {
			_, _ = w.input.Write(w.raw[:8])
		}
	}
}

func (w *studioExtremaRecorder) numericState(g *studioGraph) {
	h := sha256.New()
	var visit func(reflect.Value)
	visit = func(value reflect.Value) {
		// Dereference prepared objects; their addresses are NEVER encoded.
		// Immutable kernels and parameter metadata are independently source-bound.
		switch value.Kind() {
		case reflect.Pointer:
			if value.IsNil() {
				return
			}
			visit(value.Elem())
		case reflect.Struct:
			for i := range value.NumField() {
				name := value.Type().Field(i).Name
				if name != "params" && name != "kernel" {
					visit(value.Field(i))
				}
			}
		case reflect.Array:
			for i := range value.Len() {
				visit(value.Index(i))
			}
		case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
			reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
			reflect.Float32, reflect.Float64, reflect.Complex128:
			words := 1
			if value.Kind() == reflect.Complex128 {
				words = 2
			}
			if words > studioExtremaFixtureWords-w.words {
				w.t.Fatal("private numeric state work admission exceeded")
			}
			w.words += words
			var bits uint64
			switch value.Kind() {
			case reflect.Bool:
				if value.Bool() {
					bits = 1
				}
			case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
				bits = uint64(value.Int()) // #nosec G115 -- exact two's-complement state bits
			case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
				bits = value.Uint()
			case reflect.Float32:
				bits = uint64(math.Float32bits(float32(value.Float())))
			case reflect.Float64:
				bits = math.Float64bits(value.Float())
			case reflect.Complex128:
				pair := value.Complex()
				binary.LittleEndian.PutUint64(w.raw[8:], math.Float64bits(imag(pair)))
				bits = math.Float64bits(real(pair))
			case reflect.Invalid, reflect.Uintptr, reflect.Complex64, reflect.Array,
				reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer,
				reflect.Slice, reflect.String, reflect.Struct, reflect.UnsafePointer:
				w.t.Fatal("unsupported admitted numeric state")
			}
			binary.LittleEndian.PutUint64(w.raw[:8], bits)
			count := 8
			if value.Kind() == reflect.Complex128 {
				count = 16
			}
			_, _ = h.Write(w.raw[:count])
		case reflect.Invalid, reflect.Uintptr, reflect.Complex64, reflect.Chan,
			reflect.Func, reflect.Interface, reflect.Map, reflect.Slice, reflect.String,
			reflect.UnsafePointer:
			w.t.Fatalf("non-numeric private state kind %s", value.Kind())
		}
	}
	visit(reflect.ValueOf(g))
	w.blob(h.Sum(nil))
}

func (w *studioExtremaRecorder) controls(g *studioGraph, frame int) {
	if frame != 256 && frame != 512 && frame != 768 {
		return
	}
	cp := g.compressor.params
	lp := g.guard.params
	sp := g.saturation.params
	stereo := g.stereo.params
	switch frame {
	case 256:
		cp.ThresholdDB, cp.Ratio = -14, 3
		lp.TruePeak, lp.CeilingDBTP = false, -4
		stereo.WidthPct, stereo.MonoBass = 0, false
	case 512:
		cp.Enabled, cp.MakeupDB = false, 6
		lp.Enabled, sp.Amount, stereo.Enabled = false, 0, false
	case 768:
		cp.Enabled, cp.Ratio, cp.MakeupDB = true, 2, 2
		lp.Enabled, lp.TruePeak, lp.CeilingDBTP = true, true, -1
		sp.Amount = 15
		stereo.Enabled, stereo.WidthPct, stereo.MonoBass = true, 110, true
	}
	if err := g.compressor.setParams(cp); err != nil {
		w.t.Fatal(err)
	}
	if err := g.partitionedGuard.setParams(&g.guard, lp); err != nil {
		w.t.Fatal(err)
	}
	if err := g.saturation.setParams(sp); err != nil {
		w.t.Fatal(err)
	}
	if err := g.stereo.setParams(stereo); err != nil {
		w.t.Fatal(err)
	}
}

func (w *studioExtremaRecorder) capture(g *studioGraph, sourceLeft, sourceRight []float32, seek int, controls bool) {
	count := len(sourceLeft) - seek
	if g.repeat {
		count = 2049 + g.latency
	}
	if g.elapsed != 0 || int(g.origin) != seek {
		w.t.Fatal("private capture did not start at its requested epoch")
	}
	total := count
	if !g.repeat {
		total += g.latency
	}
	if total > studioExtremaFixtureFrames-w.frames {
		w.t.Fatal("private graph frame admission exceeded")
	}
	w.frames += total
	left, right := make([]float32, total), make([]float32, total)
	var inputLeft, inputRight [129]float32
	partitions := [...]int{1, 127, 128, 129}
	for cursor, block := 0, 0; cursor < count; block++ {
		if controls {
			w.controls(g, cursor)
		}
		n := min(partitions[block%len(partitions)], count-cursor, 128-cursor%128)
		for i := range n {
			slot := (seek + cursor + i) % len(sourceLeft)
			inputLeft[i], inputRight[i] = sourceLeft[slot], sourceRight[slot]
		}
		if got := g.processBlock(inputLeft[:n], inputRight[:n], left[cursor:cursor+n], right[cursor:cursor+n]); got != n {
			w.t.Fatalf("private source returned%d want%d", got, n)
		}
		cursor += n
	}
	if !g.repeat {
		if err := g.beginDrain(); err != nil {
			w.t.Fatal(err)
		}
		for cursor := count; cursor < total; {
			n := min(127, total-cursor)
			if got := g.drain(left[cursor:cursor+n], right[cursor:cursor+n]); got != n {
				w.t.Fatalf("private drain returned%d want%d", got, n)
			}
			cursor += n
		}
		if g.drain(left[:1], right[:1]) != 0 {
			w.t.Fatal("private drain exceeded declared latency")
		}
	}
	w.number(uint64(g.latency)) // #nosec G115 -- validated graph latency is nonnegative
	w.pcm(left, right, false)
	finalLeft, finalRight := left[g.latency:], right[g.latency:]
	for _, bits := range []int{16, 24} {
		encoded, err := audio.EncodeWAV(finalLeft, finalRight, int(g.rate), bits)
		if err != nil {
			w.t.Fatal(err)
		}
		w.blob(encoded)
	}
	w.numericState(g)
}

func TestWriteStudioExtremaGraphFixtures(t *testing.T) {
	directory := os.Getenv("AURIALIS_STUDIO_EXTREMA_FIXTURES")
	if directory == "" {
		t.Skip("private opt-in byte comparison recorder")
	}
	rate, err := strconv.Atoi(os.Getenv("AURIALIS_STUDIO_EXTREMA_RATE"))
	if err != nil || (rate != 8000 && rate != 44100 && rate != 48000 && rate != 96000 && rate != 192000) || !filepath.IsAbs(directory) {
		t.Fatal("invalid bounded private fixture admission")
	}
	// Fixed live objects plus a conservative6MiB scratch/preparation allowance.
	graphBytes := reflect.TypeFor[studioGraph]().Size() + reflect.TypeFor[Engine]().Size() + reflect.TypeFor[studioAudibleLimiterPath]().Size() + reflect.TypeFor[studioAudibleKernel]().Size() + reflect.TypeFor[studioPartitionedPostGuardPath]().Size() + reflect.TypeFor[studioPartitionedPostGuardKernel]().Size()
	if graphBytes > 2*1024*1024 {
		t.Fatal("private graph live-object capacity exceeded")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	}()
	file, err := root.OpenFile(fmt.Sprintf("rate%d.bin", rate), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			t.Error(err)
		}
	}()
	w := studioExtremaRecorder{t: t, out: bufio.NewWriterSize(file, 65536), input: sha256.New()}
	w.write([]byte("AUEXTF01"))
	w.number(uint64(rate)) // #nosec G115 -- the closed rate admission above is positive
	models := []SatCharacter{SatTube, SatTape, SatTransformer}
	topologies := []CompTopology{CompOptical, CompVariableMu, CompVCA, CompFET}
	cases := 0
	for family, model := range models {
		for topology, comp := range topologies {
			for _, repeat := range []bool{false, true} {
				p := studioAudibleGraphActiveParams()
				p.Saturation.Character, p.Compressor.Topology = model, comp
				if comp == CompFET {
					p.Compressor.KneeDB = 6
				}
				p.DitherBits = 16
				n := 1025
				if repeat {
					p.DitherBits = 24
					n = 129
				}
				w.number(uint64(family))
				w.number(uint64(topology))
				w.number(uint64(p.DitherBits)) // #nosec G115 -- fixed fixture values are 16 or 24
				metadata, err := json.Marshal(p)
				if err != nil {
					t.Fatal(err)
				}
				w.blob(metadata)
				_, _ = w.input.Write(metadata)
				left, right := studioGraphSignal(n)
				for i := range left {
					left[i], right[i] = 4*left[i], 4*right[i]
				}
				left[1], left[2], left[3] = math.Float32frombits(1), math.Float32frombits(0x80000000), float32(math.Inf(1))
				right[4] = float32(math.NaN())
				left[n-1], right[n-1] = .875, -.625
				w.pcm(left, right, true)
				g := mustStudioPartitionedAudibleGraph(t, float64(rate), p, n, repeat)
				w.capture(g, left, right, 0, true)
				if err := g.resetAt(17); err != nil {
					t.Fatal(err)
				}
				w.capture(g, left, right, 17, true)
				cases++
			}
		}
	}
	for mode := range 3 {
		p := studioGraphNeutralParams()
		if mode > 0 {
			p = studioAudibleGraphActiveParams()
			p.Bypass = mode == 1
			p.ABOriginal = mode == 2
			p.DitherBits = 24
		}
		left, right := studioGraphSignal(257)
		left[1] = math.Float32frombits(1)
		left[2] = math.Float32frombits(0x80000000)
		left[256], right[256] = .875, -.625
		w.number(uint64(100 + mode))
		w.pcm(left, right, true)
		g := mustStudioPartitionedAudibleGraph(t, float64(rate), p, len(left), false)
		w.capture(g, left, right, 0, false)
		if err := g.resetAt(17); err != nil {
			t.Fatal(err)
		}
		w.capture(g, left, right, 17, false)
		cases++
	}
	if cases != 27 {
		t.Fatal("private fixed corpus changed")
	}
	if err := w.out.Flush(); err != nil {
		t.Fatal(err)
	}
	t.Logf("cases%d rate%d baseFrames%d numericWords%d outputBytes%d fixedGraphBytes%d inputSHA256%x", cases, rate, w.frames, w.words, w.bytes, graphBytes, w.input.Sum(nil))
}
