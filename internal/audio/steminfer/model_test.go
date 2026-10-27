package steminfer

// cspell:words steminfer bytez

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func serveBytes(t *testing.T, body []byte, declaredLength int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if declaredLength >= 0 {
			w.Header().Set("Content-Length", strconv.Itoa(declaredLength))
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestDownloadVerifiesBeforePublishing(t *testing.T) {
	body := []byte("pretend model bytes")
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	for _, tc := range []struct {
		name   string
		served []byte
		length int
		size   int64
		digest string
		ok     bool
	}{
		{"exact", body, len(body), int64(len(body)), digest, true},
		{"no length header", body, -1, int64(len(body)), digest, true},
		{"tampered", []byte("pretend model bytez"), len(body), int64(len(body)), digest, false},
		{"truncated", body[:5], -1, int64(len(body)), digest, false},
		{"oversized", append(append([]byte{}, body...), 'x'), -1, int64(len(body)), digest, false},
		{"wrong declared length", body, len(body), int64(len(body)) + 1, digest, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "model.bin")
			var reported int64
			err := download(context.Background(), nil, serveBytes(t, tc.served, tc.length).URL, path, tc.size, tc.digest, func(n int64) { reported += n })
			_, statErr := os.Stat(path)
			if tc.ok {
				if err != nil || statErr != nil || reported != tc.size {
					t.Fatalf("err %v, stat %v, reported %d", err, statErr, reported)
				}
			} else if err == nil || statErr == nil {
				t.Fatalf("bad download accepted: err %v, file exists %v", err, statErr == nil)
			}
			entries, _ := os.ReadDir(dir)
			for _, entry := range entries {
				if entry.Name() != "model.bin" {
					t.Fatalf("left temporary file %s", entry.Name())
				}
			}
		})
	}
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	if err := download(context.Background(), nil, server.URL, filepath.Join(t.TempDir(), "m"), 1, digest, nil); err == nil {
		t.Fatal("404 accepted")
	}
}

// Opt-in: serves the real model to check first-use download, sharing and
// replacement of a corrupt cache.
func TestStoreDownloadsOnceAndReplacesCorruptCache(t *testing.T) {
	source := os.Getenv("AURIALIS_STEM_MODEL")
	if source == "" {
		t.Skip("set the trusted development model path")
	}
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		// #nosec G703 -- serves the explicit opt-in trusted development model path.
		http.ServeFile(w, r, source)
	}))
	defer server.Close()
	store := &Store{Dir: t.TempDir(), URL: server.URL}
	if err := os.WriteFile(store.Path(), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	models := make([]*Model, 4)
	for i := range models {
		wait.Go(func() {
			model, err := store.Model(context.Background())
			if err != nil {
				t.Error(err)
			}
			models[i] = model
		})
	}
	wait.Wait()
	if requests != 1 || models[0] == nil || models[1] != models[0] || models[3] != models[0] {
		t.Fatalf("requests %d; models shared %v", requests, models[1] == models[0])
	}
	if status := store.Status(); status.State != ModelLoaded {
		t.Fatalf("status %+v", status)
	}
	again := &Store{Dir: store.Dir, URL: server.URL}
	// A restart reports the verified cache without hashing or loading it.
	if status := again.Status(); status.State != ModelCached || again.verifications != 0 {
		t.Fatalf("restart status %+v after %d hashes", status, again.verifications)
	}
	// Without the marker (a cache from an older build) it hashes once.
	if err := os.Remove(again.markerPath()); err != nil {
		t.Fatal(err)
	}
	unmarked := &Store{Dir: store.Dir, URL: server.URL}
	if status := unmarked.Status(); status.State != ModelCached || unmarked.verifications != 1 {
		t.Fatalf("unmarked status %+v after %d hashes", status, unmarked.verifications)
	}
	if _, err := again.Model(context.Background()); err != nil || requests != 1 {
		t.Fatalf("cached model re-downloaded: %v, %d requests", err, requests)
	}
}

// A symlinked cache entry is refused, not followed: the model cache only ever
// holds a plain file this server wrote.
func TestLoadModelRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "elsewhere.safetensors")
	file, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	// The right size, so only the link itself can be the reason to refuse.
	if err := file.Truncate(modelBytes); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, modelFile)
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := LoadModel(context.Background(), link); !errors.Is(err, errNotRegularModel) {
		t.Fatalf("symlinked model: %v", err)
	}
}

func TestStoreReplacesASymlinkedCacheWithoutTouchingItsTarget(t *testing.T) {
	body := []byte("pretend separation model")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	sum := sha256.Sum256(body)
	store := &Store{Dir: t.TempDir(), URL: server.URL, size: int64(len(body)), digest: hex.EncodeToString(sum[:])}
	target := filepath.Join(t.TempDir(), "someone-elses-file")
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, store.Path()); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if got := store.Status(); got.State != ModelInvalid {
		t.Fatalf("symlinked cache status %+v", got)
	}
	// The stand-in bytes never load as a model; the point is what is on disk after.
	_, _ = store.Model(context.Background())
	info, err := os.Lstat(store.Path())
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("cache entry after the split: %v %v", info, err)
	}
	if kept, err := os.ReadFile(target); err != nil || string(kept) != string(body) {
		t.Fatalf("link target changed: %q %v", kept, err)
	}
}
