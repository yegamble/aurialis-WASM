package steminfer

// cspell:words steminfer safetensors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// ModelURL is the pinned GitHub release asset holding the converted five-head
// Mega53 weights. The download is accepted only at ModelBytes with ModelSHA256.
const ModelURL = "https://github.com/yegamble/aurialis-WASM/releases/download/stem-model-v1/mega53-five-heads-v1.safetensors"

// ModelBytes and ModelSHA256 pin the only accepted model file.
const (
	ModelBytes  = modelBytes
	ModelSHA256 = modelSHA256
	modelFile   = "mega53-five-heads-v1.safetensors"
)

// Model is a verified, immutable separator model. It is safe to share between
// jobs; each Separate call owns its own working storage.
type Model struct{ archive *weightArchive }

// LoadModel reads and verifies a model file. A wrong size, schema or checksum
// is rejected before any tensor is used.
func LoadModel(ctx context.Context, path string) (*Model, error) {
	// #nosec G304 -- path is the server's own model cache, never request input.
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() != modelBytes {
		return nil, fmt.Errorf("stem model %s is not the expected %d-byte file", path, modelBytes)
	}
	archive, err := readArchive(ctx, file, modelBytes, expectedModelSchema(), modelSHA256)
	if err != nil {
		return nil, err
	}
	return &Model{archive: archive}, nil
}

// Download fetches url into path through a temporary file in the same
// directory. It stops at ModelBytes, verifies ModelSHA256, and only then
// renames the file into place, so a partial or tampered download never
// becomes the model. progress, if set, receives bytes written so far.
func Download(ctx context.Context, client *http.Client, url, path string, progress func(written int64)) error {
	return download(ctx, client, url, path, modelBytes, modelSHA256, progress)
}

func download(ctx context.Context, client *http.Client, url, path string, size int64, digest string, progress func(int64)) error {
	if client == nil {
		client = http.DefaultClient
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("stem model download: %s", response.Status)
	}
	if response.ContentLength >= 0 && response.ContentLength != size {
		return fmt.Errorf("stem model download is %d bytes, want %d", response.ContentLength, size)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".stem-model-*.tmp")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = temp.Close()
			_ = os.Remove(temp.Name())
		}
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hash, progressWriter(progress)), io.LimitReader(response.Body, size+1))
	if err != nil {
		return fmt.Errorf("stem model download: %w", err)
	}
	if written != size {
		return fmt.Errorf("stem model download is %d bytes, want %d", written, size)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != digest {
		return errors.New("stem model download failed its checksum")
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return err
	}
	committed = true
	return nil
}

type progressWriter func(int64)

func (report progressWriter) Write(data []byte) (int, error) {
	if report != nil {
		report(int64(len(data)))
	}
	return len(data), nil
}

// Store provides the model from a cache directory, downloading it once on
// first use. Concurrent callers share one download and one loaded model.
type Store struct {
	Dir    string
	URL    string
	Client *http.Client

	mu       sync.Mutex
	model    *Model
	loading  chan struct{}
	fetching bool
	err      error
	written  int64

	// size and digest pin the accepted file; zero means the real model.
	// Tests substitute a small stand-in.
	size   int64
	digest string

	// verifyMu guards the cached on-disk verification behind Status.
	verifyMu      sync.Mutex
	checked       diskCheck
	verifications int
}

// Path is the cached model file location.
func (store *Store) Path() string { return filepath.Join(store.Dir, modelFile) }

// Model returns the verified model, loading the cached file or downloading it
// first. A failed attempt is not cached, so the next call retries.
func (store *Store) Model(ctx context.Context) (*Model, error) {
	for {
		store.mu.Lock()
		if store.model != nil {
			model := store.model
			store.mu.Unlock()
			return model, nil
		}
		if wait := store.loading; wait != nil {
			store.mu.Unlock()
			select {
			case <-wait:
				store.mu.Lock()
				model, err := store.model, store.err
				store.mu.Unlock()
				if model != nil {
					return model, nil
				}
				if err != nil {
					return nil, err
				}
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		store.loading, store.err, store.written, store.fetching = done, nil, 0, false
		store.mu.Unlock()

		// The shared load outlives one caller's cancellation so other waiters
		// are not starved; it still has its own bound through the HTTP client.
		model, err := store.load(context.WithoutCancel(ctx))
		store.mu.Lock()
		store.model, store.err, store.loading, store.fetching = model, err, nil, false
		store.mu.Unlock()
		close(done)
		if err != nil {
			return nil, err
		}
		return model, nil
	}
}

func (store *Store) load(ctx context.Context) (*Model, error) {
	path := store.Path()
	if model, err := LoadModel(ctx, path); err == nil {
		// LoadModel checked the full SHA-256, so the file is vouched for.
		store.markVerified()
		return model, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		// A corrupt or stale cache is replaced, never trusted.
		_ = os.Remove(path)
		_ = os.Remove(store.markerPath())
	}
	url := store.URL
	if url == "" {
		url = ModelURL
	}
	store.mu.Lock()
	store.fetching = true
	store.mu.Unlock()
	size, digest := store.pins()
	if err := download(ctx, store.Client, url, path, size, digest, func(n int64) {
		store.mu.Lock()
		store.written += n
		store.mu.Unlock()
	}); err != nil {
		return nil, err
	}
	store.markVerified()
	return LoadModel(ctx, path)
}
