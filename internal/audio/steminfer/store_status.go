package steminfer

// cspell:words steminfer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// ModelState is where the separation model stands, as Store.Status reports it.
type ModelState string

// The states Store.Status reports.
const (
	// ModelAbsent: no cached file; the first split downloads it.
	ModelAbsent ModelState = "absent"
	// ModelDownloading: a split is downloading the model now.
	ModelDownloading ModelState = "downloading"
	// ModelLoading: a split is reading the verified cached file into memory.
	ModelLoading ModelState = "loading"
	// ModelCached: the cached file passed its size and SHA-256 check; the
	// first split loads it without downloading.
	ModelCached ModelState = "cached"
	// ModelInvalid: a cached file exists but failed its check; the next split
	// deletes it and downloads a fresh copy.
	ModelInvalid ModelState = "invalid"
	// ModelLoaded: the model is in memory and splits start at once.
	ModelLoaded ModelState = "loaded"
)

// StoreStatus is the model's state and, while downloading, the bytes so far.
type StoreStatus struct {
	State   ModelState
	Written int64
}

// diskCheck remembers one verification result for a file's size,
// modification time and change stamp, so a cached model is hashed at most
// once per version.
type diskCheck struct {
	size   int64
	mtime  time.Time
	change string
	state  ModelState
}

func (check diskCheck) matches(info fs.FileInfo) bool {
	return check.state != "" && check.size == info.Size() && check.mtime.Equal(info.ModTime()) && check.change == changeStamp(info)
}

func newDiskCheck(info fs.FileInfo, state ModelState) diskCheck {
	return diskCheck{size: info.Size(), mtime: info.ModTime(), change: changeStamp(info), state: state}
}

func (store *Store) pins() (int64, string) {
	if store.size > 0 {
		return store.size, store.digest
	}
	return modelBytes, modelSHA256
}

// markerPath holds the record of the last successful SHA-256 check: the
// file's size, modification time and, on macOS and Linux, its inode and change
// time (changeStamp), which any later write moves. It only shapes the status
// shown before a split: LoadModel re-verifies the full hash
// before any tensor is used, so a forged marker can never feed bad weights to
// inference.
func (store *Store) markerPath() string { return store.Path() + ".verified" }

func (store *Store) marker(info fs.FileInfo) string {
	_, digest := store.pins()
	return "aurialis-stem-model sha256=" + digest + " size=" + strconv.FormatInt(info.Size(), 10) + " mtime=" + strconv.FormatInt(info.ModTime().UnixNano(), 10) + " change=" + changeStamp(info) + "\n"
}

// Status reports the model's state without loading it. A cached file is
// checked by size, then by a marker written after a verified SHA-256, and
// otherwise hashed once (about 176 MB) and remembered by size, modification
// time and change stamp.
func (store *Store) Status() StoreStatus {
	store.mu.Lock()
	switch {
	case store.model != nil:
		store.mu.Unlock()
		return StoreStatus{State: ModelLoaded}
	case store.loading != nil && store.fetching:
		written := store.written
		store.mu.Unlock()
		return StoreStatus{State: ModelDownloading, Written: written}
	case store.loading != nil:
		store.mu.Unlock()
		return StoreStatus{State: ModelLoading}
	}
	store.mu.Unlock()
	return StoreStatus{State: store.diskState()}
}

func (store *Store) diskState() ModelState {
	store.verifyMu.Lock()
	defer store.verifyMu.Unlock()
	size, digest := store.pins()
	info, err := os.Lstat(store.Path())
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return ModelAbsent
	case err != nil || !info.Mode().IsRegular() || info.Size() != size:
		return ModelInvalid
	case store.checked.matches(info):
		return store.checked.state
	}
	state := ModelInvalid
	// #nosec G304 -- the server's own model cache marker, never request input.
	if marker, err := os.ReadFile(store.markerPath()); err == nil && string(marker) == store.marker(info) {
		state = ModelCached
	} else if store.hashMatches(digest) {
		state = ModelCached
		store.writeMarker(info)
	}
	store.checked = newDiskCheck(info, state)
	return state
}

func (store *Store) hashMatches(digest string) bool {
	store.verifications++
	file, _, err := openRegular(store.Path())
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false
	}
	return hex.EncodeToString(hash.Sum(nil)) == digest
}

// markVerified records that the file now at Path passed its SHA-256 check.
func (store *Store) markVerified() {
	store.verifyMu.Lock()
	defer store.verifyMu.Unlock()
	info, err := os.Lstat(store.Path())
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	store.writeMarker(info)
	store.checked = newDiskCheck(info, ModelCached)
}

// writeMarker is best effort: without it, the next server start hashes once.
func (store *Store) writeMarker(info fs.FileInfo) {
	temp, err := os.CreateTemp(filepath.Dir(store.Path()), ".stem-model-marker-*.tmp")
	if err != nil {
		return
	}
	_, writeErr := temp.WriteString(store.marker(info))
	closeErr := temp.Close()
	if writeErr != nil || closeErr != nil || os.Rename(temp.Name(), store.markerPath()) != nil {
		_ = os.Remove(temp.Name())
	}
}
