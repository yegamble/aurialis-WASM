package dsp

import "math"

const (
	studioPostPartitionFrames = 128
	studioPostPartitionFFT    = 2 * studioPostPartitionFrames
	studioPostPartitions      = 1024 / studioPostPartitionFrames
	studioPostPartitionDelay  = studioPostPartitionFrames - 1
)

// This private comparison keeps the frozen FIR coefficients. FFT arithmetic
// changes summation order; it needs independent error/output qualification.
// Availability is explicitly127 base frames later than the direct detector.
// No graph or public capability selects this experiment.
type studioPartitionedPostGuardKernel struct {
	responses [3][studioPostPartitions][studioPostPartitionFFT]complex128
	twiddles  [studioPostPartitionFFT / 2]complex128
	inverse   [studioPostPartitionFFT / 2]complex128
	reversed  [studioPostPartitionFFT]int
}

func prepareStudioPartitionedPostGuardKernel() *studioPartitionedPostGuardKernel {
	k := new(studioPartitionedPostGuardKernel)
	for i := range k.twiddles {
		sine, cosine := math.Sincos(-2 * math.Pi * float64(i) / studioPostPartitionFFT)
		k.twiddles[i], k.inverse[i] = complex(cosine, sine), complex(cosine, -sine)
	}
	for i := range k.reversed {
		value, reverse := i, 0
		for range 8 {
			reverse, value = 2*reverse+(value&1), value>>1
		}
		k.reversed[i] = reverse
	}
	frozen := prepareStudioPostGuardKernel()
	for phase := range k.responses {
		for partition := range k.responses[phase] {
			response := &k.responses[phase][partition]
			for i := range studioPostPartitionFrames {
				tap := partition*studioPostPartitionFrames + i
				coefficient := 0.0
				switch phase {
				case 0:
					coefficient = frozen.quarter[tap]
				case 1:
					coefficient = frozen.half[min(tap, 1023-tap)]
				case 2:
					coefficient = frozen.quarter[1023-tap]
				}
				response[i] = complex(coefficient, 0)
			}
			k.transform(response, false)
		}
	}
	return k
}

// All roots and bit-reversed indices are prepared before processing. Complex
// input packs independent stereo channels; convolution by a REAL FIR preserves
// that packing. Fixed overlap-save arrays avoid audio-path allocation/trig.
func (k *studioPartitionedPostGuardKernel) transform(values *[studioPostPartitionFFT]complex128, inverse bool) {
	roots := &k.twiddles
	if inverse {
		roots = &k.inverse
	}
	for i, reversed := range &k.reversed {
		other := reversed
		if other > i {
			values[i], values[other] = values[other], values[i]
		}
	}
	for length := 2; length <= studioPostPartitionFFT; length *= 2 {
		half, stride := length/2, studioPostPartitionFFT/length
		for start := 0; start < studioPostPartitionFFT; start += length {
			for i := range half {
				root := roots[i*stride]
				first, second := values[start+i], root*values[start+i+half]
				values[start+i], values[start+i+half] = first+second, first-second
			}
		}
	}
	if inverse {
		for i := range values {
			values[i] /= studioPostPartitionFFT
		}
	}
}

type studioPartitionedPostGuardDetector struct {
	input       [studioPostPartitionFFT]complex128
	spectra     [studioPostPartitions][studioPostPartitionFFT]complex128
	output      [3][studioPostPartitionFFT]complex128
	scratch     [studioPostPartitionFFT]complex128
	original    [1024]complex128
	base        [studioPostPartitionFrames]complex128
	peaks       [studioPostPartitionFrames]float64
	subs        [2][8]float64
	frame       int64
	head        int
	subCursor   int
	pendingPeak float64
}

func (s *studioPartitionedPostGuardDetector) convolve(k *studioPartitionedPostGuardKernel) {
	copy(s.scratch[:], s.input[:])
	k.transform(&s.scratch, false)
	s.spectra[s.head] = s.scratch
	for phase := range s.output {
		output := &s.output[phase]
		clear(output[:])
		for partition := range k.responses[phase] {
			response := &k.responses[phase][partition]
			input := &s.spectra[(s.head-partition)&(studioPostPartitions-1)]
			for bin, coefficient := range response {
				output[bin] += input[bin] * coefficient
			}
		}
		k.transform(output, true)
	}
	copy(s.input[:studioPostPartitionFrames], s.input[studioPostPartitionFrames:])
	s.head = (s.head + 1) & (studioPostPartitions - 1)
}

func (s *studioPartitionedPostGuardDetector) sealBlock() {
	for i := range studioPostPartitionFrames {
		samples := [4]complex128{s.base[i], s.output[0][studioPostPartitionFrames+i], s.output[1][studioPostPartitionFrames+i], s.output[2][studioPostPartitionFrames+i]}
		for phase, sample := range samples {
			cursor := s.subCursor
			for ch, value := range [2]float64{real(sample), imag(sample)} {
				history := &s.subs[ch]
				history[cursor] = value
				peak := studioRefinedPeak(history[(cursor-5)&7], history[(cursor-4)&7], history[(cursor-3)&7], history[(cursor-2)&7], history[(cursor-1)&7], value)
				s.pendingPeak = math.Max(s.pendingPeak, peak)
			}
			s.subCursor = (cursor + 1) & 7
			if phase == 2 {
				s.peaks[i] = s.pendingPeak
				s.pendingPeak = 0
			}
		}
	}
}

func (s *studioPartitionedPostGuardDetector) process(k *studioPartitionedPostGuardKernel, left, right float64) (int64, float64) {
	position := int(s.frame) & (studioPostPartitionFrames - 1)
	cursor := int(s.frame) & 1023
	s.original[cursor] = complex(left, right)
	s.input[studioPostPartitionFrames+position] = complex(left, right)
	s.base[position] = s.original[(cursor-studioPostGuardHalf)&1023]
	if position == studioPostPartitionFrames-1 {
		s.convolve(k)
		s.sealBlock()
	}
	peak := 0.0
	if s.frame >= studioPostPartitionDelay {
		peak = s.peaks[(position+1)&(studioPostPartitionFrames-1)]
	}
	index := s.frame - studioPostGuardAvailability - studioPostPartitionDelay
	s.frame++
	return index, peak
}
