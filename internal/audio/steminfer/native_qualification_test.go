package steminfer

// cspell:words gonum SSE3

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Generated from the unchanged independent evaluator, original checkpoint pin,
// and deterministic synthetic broadband source; never a user's uploaded audio.
const nativeSyntheticOracleSHA256 = "5e8589f0f4b78f3cea7dec1a0203bab1b951741a28b6ff4e8ce3e44056a90fcc"

func verifyNativeSyntheticOracle(t *testing.T, metadata, raw []byte) {
	t.Helper()
	var provenance struct {
		Fixture  string `json:"fixture"`
		Original string `json:"originalSHA256"`
		Binary   string `json:"binarySHA256"`
		Samples  int    `json:"samples"`
	}
	if err := json.Unmarshal(metadata, &provenance); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	if provenance.Fixture != "broadband" || provenance.Samples != maximumWindowSamples || provenance.Original != originalCheckpointSHA256 || provenance.Binary != nativeSyntheticOracleSHA256 || digest != nativeSyntheticOracleSHA256 {
		t.Fatal("native qualification requires the pinned independent synthetic full-window oracle")
	}
}
func observeNativeQualificationHeap(t *testing.T, oracleBytes int) func() {
	t.Helper()
	var peak atomic.Uint64
	sample := func() {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		for {
			previous := peak.Load()
			if stats.HeapAlloc <= previous || peak.CompareAndSwap(previous, stats.HeapAlloc) {
				return
			}
		}
	}
	sample()
	stop := make(chan struct{})
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sample()
			case <-stop:
				return
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-joined
			sample()
			maximum := uint64(maximumPrivateJobBytes + modelBytes + int64(oracleBytes) + 64*1024*1024) // #nosec G115 -- oracleBytes is a bounded positive fixture length
			t.Logf("native qualification peak Go heap=%d bytes, fixture-inclusive bound=%d", peak.Load(), maximum)
			if peak.Load() > maximum {
				t.Errorf("native model exceeded bounded Go-heap qualification allowance")
			}
		})
	}
}
func verifyNativeWindowCancellation(t *testing.T, runner *windowRunner, left, right []float32) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(50*time.Millisecond, cancel)
	defer timer.Stop()
	started := time.Now()
	err := runner.predict(ctx, left, right, []int{0, 1, 2, 3, 4}, func(int, []float32, []float32) error { return nil }, inferenceHooks{})
	elapsed := time.Since(started)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("same-model native inference ignored cancellation", err)
	}
	if elapsed > time.Second {
		t.Errorf("same-model cancellation took %s, want at most one second", elapsed)
	}
	t.Logf("same-model cancellation returned after %s", elapsed)
}

const nativeSyntheticOracleBytes = 42336000

func readFullWindowOracle(directory string) ([]byte, error) {
	raw, err := boundedTestArtifact(filepath.Join(directory, "oracle.bin"), 256<<20)
	if !errors.Is(err, os.ErrNotExist) {
		return raw, err
	}
	compressed, err := boundedTestArtifact(filepath.Join(directory, "oracle.bin.gz"), 50<<20)
	if err != nil {
		return nil, err
	}
	raw, err = decompressNativeOracle(compressed, nativeSyntheticOracleBytes)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != nativeSyntheticOracleSHA256 {
		return nil, errors.New("synthetic oracle checksum mismatch")
	}
	return raw, nil
}
func decompressNativeOracle(compressed []byte, expected int) ([]byte, error) {
	if len(compressed) > 50<<20 || expected < 1 || expected > nativeSyntheticOracleBytes {
		return nil, errors.New("synthetic oracle exceeds bounded fixture size")
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	raw := make([]byte, expected)
	if _, err = io.ReadFull(reader, raw); err != nil {
		return nil, fmt.Errorf("truncated synthetic oracle: %w", err)
	}
	var extra [1]byte
	if count, readErr := reader.Read(extra[:]); count != 0 || !errors.Is(readErr, io.EOF) {
		return nil, errors.New("invalid or excessive synthetic oracle gzip stream")
	}
	return raw, nil
}
func TestNativeOracleDecompressionRejectsMalformedAndExcessiveData(t *testing.T) {
	encode := func(raw []byte) []byte {
		var buffer bytes.Buffer
		writer := gzip.NewWriter(&buffer)
		if _, err := writer.Write(raw); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}
	valid := encode(make([]byte, 64))
	if decoded, err := decompressNativeOracle(valid, 64); err != nil || len(decoded) != 64 {
		t.Fatal("valid bounded oracle rejected", err)
	}
	corrupt := append([]byte(nil), valid...)
	corrupt[len(corrupt)-5] ^= 1
	for _, data := range [][]byte{encode(make([]byte, 65)), encode(make([]byte, 63)), corrupt, valid[:len(valid)-4]} {
		if _, err := decompressNativeOracle(data, 64); err == nil {
			t.Fatal("invalid compressed fixture accepted")
		}
	}
	if _, err := decompressNativeOracle(valid, nativeSyntheticOracleBytes+1); err == nil {
		t.Fatal("excessive allocation requested")
	}
}
