package browserjobs

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

func TestAlbumOverlapIsLinearBoundedAndKeepsInputs(t *testing.T) {
	left, right := make([]float32, 16), make([]float32, 16)
	for i := range left {
		left[i], right[i] = 1, -1
	}
	a, err := audio.EncodeWAV(left, right, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	b, err := audio.EncodeWAV(right, left, 48000, 32)
	if err != nil {
		t.Fatal(err)
	}
	originalA, originalB := bytes.Clone(a), bytes.Clone(b)
	result, err := Execute(context.Background(), []byte(`{"operation":"transition","bitDepth":32}`), a, b, nil)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := audio.DecodeAndDisarm("result.wav", result.Audio)
	if err != nil {
		t.Fatal(err)
	}
	for i := range left {
		want := float32(1 - 2*float64(i)/15)
		if decoded.Left[i] != want || decoded.Right[i] != -want {
			t.Fatalf("frame %d: %g/%g, want %g/%g", i, decoded.Left[i], decoded.Right[i], want, -want)
		}
	}
	if !bytes.Equal(a, originalA) || !bytes.Equal(b, originalB) {
		t.Fatal("input master was changed")
	}
}

func TestAlbumOverlapRejectsIncompatibleEdgesAndCancellation(t *testing.T) {
	a, err := audio.EncodeWAV(make([]float32, 64), make([]float32, 64), 48000, 24)
	if err != nil {
		t.Fatal(err)
	}
	b, err := audio.EncodeWAV(make([]float32, 64), make([]float32, 64), 44100, 24)
	if err != nil {
		t.Fatal(err)
	}
	request := []byte(`{"operation":"transition","bitDepth":24}`)
	if _, err := Execute(context.Background(), request, a, b, nil); err == nil {
		t.Fatal("accepted differing rates")
	}
	if _, err := Execute(context.Background(), request, a, nil, nil); err == nil {
		t.Fatal("accepted missing edge")
	}
	if _, err := Execute(context.Background(), []byte(`{"operation":"transition","bitDepth":8}`), a, a, nil); err == nil {
		t.Fatal("accepted unsupported bit depth")
	}
	if _, err := DecodeRequest([]byte(`{"operation":"transition","params":"{}"}`)); err == nil {
		t.Fatal("accepted unrelated processing")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Execute(ctx, request, a, a, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
