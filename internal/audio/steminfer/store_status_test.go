package steminfer

// cspell:words steminfer modex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// smallStore pins a tiny stand-in model so status can be checked without the
// real 176 MB file.
func smallStore(t *testing.T, body []byte) *Store {
	t.Helper()
	sum := sha256.Sum256(body)
	return &Store{Dir: t.TempDir(), size: int64(len(body)), digest: hex.EncodeToString(sum[:])}
}

func TestStoreStatusReportsOnDiskStates(t *testing.T) {
	body := []byte("pretend separation model")
	for _, tc := range []struct {
		name string
		file []byte
		want ModelState
	}{
		{"absent", nil, ModelAbsent},
		{"cached and verified", body, ModelCached},
		{"wrong size", body[:5], ModelInvalid},
		{"right size, wrong hash", []byte("pretend separation modex"), ModelInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := smallStore(t, body)
			if tc.file != nil {
				if err := os.WriteFile(store.Path(), tc.file, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if got := store.Status(); got.State != tc.want || got.Written != 0 {
				t.Fatalf("status %+v, want %s", got, tc.want)
			}
			_, markerErr := os.Stat(store.markerPath())
			if (tc.want == ModelCached) != (markerErr == nil) {
				t.Fatalf("marker written %v for state %s", markerErr == nil, tc.want)
			}
		})
	}
}

func TestStoreStatusHashesACachedModelOnce(t *testing.T) {
	body := []byte("pretend separation model")
	store := smallStore(t, body)
	if err := os.WriteFile(store.Path(), body, 0o600); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if got := store.Status(); got.State != ModelCached {
			t.Fatalf("status %+v", got)
		}
	}
	if store.verifications != 1 {
		t.Fatalf("hashed %d times, want once", store.verifications)
	}
	// A restarted server trusts the marker written after the verified hash.
	restarted := &Store{Dir: store.Dir, size: store.size, digest: store.digest}
	if got := restarted.Status(); got.State != ModelCached || restarted.verifications != 0 {
		t.Fatalf("restart status %+v after %d hashes", got, restarted.verifications)
	}
	// Replacing the file changes its modification time, so the marker no
	// longer vouches for it and the tampered bytes are hashed and rejected.
	if err := os.WriteFile(store.Path(), []byte("pretend separation modex"), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(store.Path(), later, later); err != nil {
		t.Fatal(err)
	}
	if got := restarted.Status(); got.State != ModelInvalid || restarted.verifications != 1 {
		t.Fatalf("tampered status %+v after %d hashes", got, restarted.verifications)
	}
}

// Rewriting the cached file in place at the same size and putting its
// modification time back must not keep the "cached" status: the marker also
// records the change time, which the kernel sets on every write and which
// cannot be set back.
func TestStoreStatusRehashesASameSizeEditWithRestoredMtime(t *testing.T) {
	body := []byte("pretend separation model")
	store := smallStore(t, body)
	if err := os.WriteFile(store.Path(), body, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := store.Status(); got.State != ModelCached {
		t.Fatalf("status %+v", got)
	}
	before, err := os.Stat(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	if changeStamp(before) == "" {
		t.Skip("this platform reports no change time; the marker uses size and modification time only")
	}
	// Some kernels advance the change time on a coarse clock tick.
	time.Sleep(50 * time.Millisecond)
	if err := os.WriteFile(store.Path(), []byte("pretend separation modex"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(store.Path(), before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if got := store.Status(); got.State != ModelInvalid || store.verifications != 2 {
		t.Fatalf("same-size edit status %+v after %d hashes", got, store.verifications)
	}
	restarted := &Store{Dir: store.Dir, size: store.size, digest: store.digest}
	if got := restarted.Status(); got.State != ModelInvalid || restarted.verifications != 1 {
		t.Fatalf("restart status %+v after %d hashes", got, restarted.verifications)
	}
}

func TestStoreStatusIgnoresAForgedMarker(t *testing.T) {
	body := []byte("pretend separation model")
	store := smallStore(t, body)
	tampered := []byte("pretend separation modex")
	if err := os.WriteFile(store.Path(), tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	forged := "aurialis-stem-model sha256=0000 size=" + strconv.FormatInt(info.Size(), 10) + " mtime=" + strconv.FormatInt(info.ModTime().UnixNano(), 10) + "\n"
	if err := os.WriteFile(store.markerPath(), []byte(forged), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := store.Status(); got.State != ModelInvalid {
		t.Fatalf("forged marker trusted: %+v", got)
	}
}

func TestStoreStatusReportsInMemoryStates(t *testing.T) {
	store := smallStore(t, []byte("x"))
	store.loading = make(chan struct{})
	if got := store.Status(); got.State != ModelLoading {
		t.Fatalf("loading a cached file reported %+v", got)
	}
	store.fetching, store.written = true, 7
	if got := store.Status(); got.State != ModelDownloading || got.Written != 7 {
		t.Fatalf("download reported %+v", got)
	}
	store.loading, store.fetching, store.model = nil, false, &Model{}
	if got := store.Status(); got.State != ModelLoaded {
		t.Fatalf("loaded model reported %+v", got)
	}
}

func TestStoreStatusDuringARealDownload(t *testing.T) {
	body := []byte("pretend separation model")
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body[:4])
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write(body[4:])
	}))
	defer server.Close()
	store := smallStore(t, body)
	store.URL = server.URL
	done := make(chan error, 1)
	go func() { _, err := store.Model(context.Background()); done <- err }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := store.Status()
		if got.State == ModelDownloading && got.Written == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never saw the download: %+v", got)
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	// The stand-in bytes are not a real model, so loading fails after the
	// verified download; the file itself is the verified cache.
	if err := <-done; err == nil {
		t.Fatal("stand-in model loaded")
	}
	if got := store.Status(); got.State != ModelCached {
		t.Fatalf("after download %+v", got)
	}
}

func TestStoreStatusReportsLoadingAfterADownload(t *testing.T) {
	body := []byte("pretend separation model")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	store := smallStore(t, body)
	store.URL = server.URL
	downloaded, release := make(chan struct{}), make(chan struct{})
	store.afterDownload = func() { close(downloaded); <-release }
	done := make(chan error, 1)
	go func() { _, err := store.Model(context.Background()); done <- err }()
	<-downloaded
	// The bytes are on disk and verified; reading them into memory is loading,
	// not a download stuck at 100%.
	if got := store.Status(); got.State != ModelLoading {
		t.Fatalf("after the download finished, status %+v", got)
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("stand-in model loaded")
	}
}

func TestBackendReportsAcceleration(t *testing.T) {
	if Accelerated() != (Backend() == "apple-accelerate" || Backend() == "packed-avx2-fma") {
		t.Fatalf("accelerated %v with backend %s", Accelerated(), Backend())
	}
	if runtime.GOOS != "darwin" && Backend() == "apple-accelerate" {
		t.Fatalf("%s reported Accelerate", runtime.GOOS)
	}
	speed, ok := RecordedSpeed()
	if ok != (Backend() == "apple-accelerate") {
		t.Fatalf("recorded speed %v on accelerated %v", ok, Accelerated())
	}
	if ok && (speed.IdleSecondsPerWindow != 32 || speed.BusySecondsPerWindow != 173) {
		t.Fatalf("speed %+v does not match the recorded figures in docs/tasks.md", speed)
	}
	if speed.WindowSeconds != float64(maximumWindowSamples)/modelSampleRate || speed.HopSeconds != speed.WindowSeconds/2 {
		t.Fatalf("geometry %+v", speed)
	}
}

func TestWindowsMatchesTheChunkAssembler(t *testing.T) {
	for _, seconds := range []float64{1, 10, 19.5, 20, 21, 60, 225, 240, 348} {
		frames := int(seconds * modelSampleRate)
		work, err := newChunkAssembler(frames, maximumWindowSamples, 1)
		if err != nil {
			t.Fatal(err)
		}
		if want := (work.total + work.step - 1) / work.step; Windows(seconds) != want {
			t.Fatalf("%v s: Windows %d, assembler %d", seconds, Windows(seconds), want)
		}
	}
	// The client's stemWindows test (src/lib/__tests__/stem-split-copy.test.ts)
	// pins the same table, so the two counts cannot drift apart.
	for seconds, want := range map[float64]int{1: 1, 10: 1, 19.5: 2, 20: 2, 21: 5, 60: 8, 225: 25, 240: 26, 348: 37} {
		if got := Windows(seconds); got != want {
			t.Fatalf("%v s: %d windows, client table says %d", seconds, got, want)
		}
	}
	if Windows(0) != 0 || Windows(-1) != 0 {
		t.Fatal("empty song needs windows")
	}
}
