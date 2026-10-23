package mastering

import (
	"context"
	"errors"
	"math"
	"math/cmplx"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// Streaming two-pass analysis removes the exact rendered DC mean without retaining
// song-length output buffers. Scratch depends on FFT size, never source duration.
func renderedReferenceBassPower(ctx context.Context, source *audio.Buffer, params dsp.Params, edges [6]float64) (float64, error) {
	engine := dsp.NewEngine(float64(source.SampleRate))
	engine.SetParams(params)
	if engine.LatencyFrames() != 0 {
		return 0, errors.New("rendered reference guard requires zero-buffered-latency algorithm1")
	}
	meanLeft, meanRight, err := renderedReferenceMeans(ctx, source, engine)
	if err != nil {
		return 0, err
	}
	engine.Reset()
	engine.SetParams(params)
	size := 1024
	for size < source.SampleRate/16 && size < 16384 {
		size *= 2
	}
	hop := size / 4
	left, right := make([]float32, size), make([]float32, size)
	scratch := make([]complex128, size)
	weights := make([]float64, size)
	weightPower := 0.0
	for i := range weights {
		weights[i] = .5 - .5*math.Cos(2*math.Pi*float64(i)/float64(size))
		weightPower += weights[i] * weights[i]
	}
	total := 0.0
	for start := 0; start < len(source.Left)+3*hop; start += hop {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		copy(left, left[hop:])
		copy(right, right[hop:])
		clear(left[size-hop:])
		clear(right[size-hop:])
		if start < len(source.Left) {
			end := min(start+hop, len(source.Left))
			engine.ProcessBlock(source.Left[start:end], source.Right[start:end], left[size-hop:size-hop+end-start], right[size-hop:size-hop+end-start])
		}
		for i := range scratch {
			index := start - 3*hop + i
			if index >= 0 && index < len(source.Left) {
				l, r := float64(left[i]), float64(right[i])
				if !isFinite(l) || !isFinite(r) {
					return 0, errors.New("reference render produced invalid samples")
				}
				scratch[i] = complex((l-meanLeft)*weights[i], (r-meanRight)*weights[i])
			} else {
				scratch[i] = 0
			}
		}
		fftInPlace(scratch)
		total += referenceBassWindowPower(scratch, source.SampleRate, weightPower, edges[0], edges[1]) * float64(hop)
	}
	return total / float64(len(source.Left)), nil
}

func renderedReferenceMeans(ctx context.Context, source *audio.Buffer, engine *dsp.Engine) (float64, float64, error) {
	var left, right [4096]float32
	meanLeft, meanRight := 0.0, 0.0
	for start := 0; start < len(source.Left); start += len(left) {
		if err := ctx.Err(); err != nil {
			return 0, 0, err
		}
		count := min(len(left), len(source.Left)-start)
		engine.ProcessBlock(source.Left[start:start+count], source.Right[start:start+count], left[:count], right[:count])
		for i := range count {
			l, r := float64(left[i]), float64(right[i])
			if !isFinite(l) || !isFinite(r) {
				return 0, 0, errors.New("reference render produced invalid samples")
			}
			meanLeft += l
			meanRight += r
		}
	}
	return meanLeft / float64(len(source.Left)), meanRight / float64(len(source.Left)), nil
}

func referenceBassWindowPower(scratch []complex128, rate int, weightPower, low, high float64) float64 {
	size := len(scratch)
	binWidth := float64(rate) / float64(size)
	total := 0.0
	for k := 0; k <= size/2; k++ {
		frequency := float64(k) * binWidth
		binLow, binHigh := math.Max(0, frequency-binWidth/2), math.Min(float64(rate)/2, frequency+binWidth/2)
		fraction := math.Max(0, math.Min(binHigh, high)-math.Max(binLow, low)) / (binHigh - binLow)
		if fraction == 0 {
			continue
		}
		left := (scratch[k] + cmplx.Conj(scratch[(size-k)%size])) / 2
		right := (scratch[k] - cmplx.Conj(scratch[(size-k)%size])) / complex(0, 2)
		power := (real(left)*real(left) + imag(left)*imag(left) + real(right)*real(right) + imag(right)*imag(right)) / 2
		power /= float64(size) * weightPower
		if k != 0 && k != size/2 {
			power *= 2
		}
		total += power * fraction
	}
	return total
}
