package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestSpectrumReconstructionPreservesExactNonHopLength(t *testing.T) {
	for _, samples := range []int{1025, 1027, 2048, 2053, 4097, 44100} {
		frames := samples/fftHop + 1
		work := newSpectrumWorkspace(frames)
		left, right := make([]float32, samples), make([]float32, samples)
		for i := range left {
			left[i] = float32(.05 + .2*math.Sin(float64(i)*.13))
			right[i] = float32(-.01 + .1*math.Cos(float64(i)*.37))
		}
		left[0] = .9
		right[len(right)-1] = -.8
		features := make([]float32, frames*featureCount)
		if err := work.features(context.Background(), left, right, features); err != nil {
			t.Fatal(err)
		}
		spectrum := make([]complex64, frames*spectrumBins*2)
		for i := range spectrum {
			spectrum[i] = complex(features[2*i], features[2*i+1])
		}
		reconstructedL, reconstructedR, err := work.reconstruct(context.Background(), spectrum, samples, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(reconstructedL) != samples || len(reconstructedR) != samples {
			t.Fatal("inverse transform truncated source frames", samples)
		}
		for i := range left {
			if math.Abs(float64(left[i]-reconstructedL[i])) > 2e-7 || math.Abs(float64(right[i]-reconstructedR[i])) > 2e-7 {
				t.Fatal("reconstruction error", samples, i, left[i]-reconstructedL[i], right[i]-reconstructedR[i])
			}
		}
	}
}
func TestSpectrumRejectsShortNonFiniteAndCanceledInputs(t *testing.T) {
	work := newSpectrumWorkspace(3)
	if err := work.features(context.Background(), []float32{1}, []float32{1}, nil); err == nil {
		t.Fatal("raw short window accepted without required outer padding")
	}
	left, right := make([]float32, 1025), make([]float32, 1025)
	features := make([]float32, 3*featureCount)
	left[7] = float32(math.NaN())
	if err := work.features(context.Background(), left, right, features); err == nil {
		t.Fatal("non-finite source accepted")
	}
	left[7] = 0
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := work.features(ctx, left, right, features); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled transform ran", err)
	}
}
