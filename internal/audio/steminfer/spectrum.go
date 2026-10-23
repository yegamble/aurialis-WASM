package steminfer

// cspell:words steminfer istft stft

import (
	"context"
	"errors"
	"math"
	"math/cmplx"
)

type spectrumWorkspace struct {
	window                []float32
	fft                   []complex128
	envelope, left, right []float32
}

func newSpectrumWorkspace(frames int) spectrumWorkspace {
	full := fftSize + fftHop*(frames-1)
	work := spectrumWorkspace{window: make([]float32, fftSize), fft: make([]complex128, fftSize), envelope: make([]float32, full), left: make([]float32, full), right: make([]float32, full)}
	for i := range work.window {
		work.window[i] = float32(.5 - .5*math.Cos(2*math.Pi*float64(i)/fftSize))
	}
	for frame := range frames {
		for i, weight := range work.window {
			work.envelope[frame*fftHop+i] += weight * weight
		}
	}
	return work
}
func transformFFT(values []complex128, inverse bool) {
	count := len(values)
	for i, j := 1, 0; i < count; i++ {
		bit := count >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for width := 2; width <= count; width <<= 1 {
		angle := -2 * math.Pi / float64(width)
		if inverse {
			angle = -angle
		}
		rotation := cmplx.Rect(1, angle)
		for first := 0; first < count; first += width {
			phase := complex(1, 0)
			for i := 0; i < width/2; i++ {
				a, b := values[first+i], values[first+i+width/2]*phase
				values[first+i], values[first+i+width/2] = a+b, a-b
				phase *= rotation
			}
		}
	}
	if inverse {
		for i := range values {
			values[i] /= complex(float64(count), 0)
		}
	}
}
func reflectedIndex(index, length int) int {
	if index < 0 {
		return -index
	}
	if index >= length {
		return 2*(length-1) - index
	}
	return index
}
func finite32(value float32) bool {
	return !math.IsNaN(float64(value)) && !math.IsInf(float64(value), 0)
}
func (work *spectrumWorkspace) features(ctx context.Context, left, right, output []float32) error {
	frames := len(left)/fftHop + 1
	if ctx == nil || len(left) <= fftSize/2 || len(left) != len(right) || len(left) > maximumWindowSamples || len(output) != frames*featureCount {
		return errors.New("invalid bounded model window")
	}
	for i := range left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if !finite32(left[i]) || !finite32(right[i]) {
			return errors.New("non-finite source PCM")
		}
	}
	for frame := range frames {
		if err := ctx.Err(); err != nil {
			return err
		}
		for channel, samples := range [2][]float32{left, right} {
			for i, weight := range work.window {
				index := reflectedIndex(frame*fftHop-fftSize/2+i, len(samples))
				work.fft[i] = complex(float64(samples[index]*weight), 0)
			}
			transformFFT(work.fft, false)
			for bin := range spectrumBins {
				r, im := float32(real(work.fft[bin])), float32(imag(work.fft[bin]))
				if !finite32(r) || !finite32(im) {
					return errors.New("source spectrum exceeds finite inference range")
				}
				offset := frame*featureCount + bin*4 + channel*2
				output[offset], output[offset+1] = r, im
			}
		}
	}
	return nil
}
func (work *spectrumWorkspace) reconstruct(ctx context.Context, spectra []complex64, samples int, zeroDC bool) ([]float32, []float32, error) {
	frames := samples/fftHop + 1
	if ctx == nil || samples <= fftSize/2 || samples > maximumWindowSamples || len(spectra) != frames*spectrumBins*2 {
		return nil, nil, errors.New("invalid output spectrum layout")
	}
	clear(work.left)
	clear(work.right)
	for channel, destination := range [2][]float32{work.left, work.right} {
		for frame := range frames {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			clear(work.fft)
			for bin := range spectrumBins {
				value := spectra[(frame*spectrumBins+bin)*2+channel]
				if !finite32(real(value)) || !finite32(imag(value)) {
					return nil, nil, errors.New("non-finite predicted spectrum")
				}
				if bin == 0 && zeroDC {
					value = 0
				}
				if bin == 0 || bin == spectrumBins-1 {
					value = complex(real(value), 0)
				}
				work.fft[bin] = complex128(value)
				if bin > 0 && bin < spectrumBins-1 {
					work.fft[fftSize-bin] = cmplx.Conj(complex128(value))
				}
			}
			transformFFT(work.fft, true)
			for i, weight := range work.window {
				destination[frame*fftHop+i] += float32(real(work.fft[i])) * weight
			}
		}
	}
	for _, destination := range [2][]float32{work.left, work.right} {
		for i := fftSize / 2; i < fftSize/2+samples; i++ {
			if work.envelope[i] <= 1e-11 {
				return nil, nil, errors.New("vanishing reconstruction window")
			}
			destination[i] /= work.envelope[i]
			if !finite32(destination[i]) {
				return nil, nil, errors.New("non-finite predicted PCM")
			}
		}
	}
	return work.left[fftSize/2 : fftSize/2+samples], work.right[fftSize/2 : fftSize/2+samples], nil
}
