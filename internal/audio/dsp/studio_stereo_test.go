package dsp

import (
	"math"
	"math/cmplx"
	"testing"
)

func studioLR4Tone(rate, cutoff, frequency float64) (complex128, complex128) {
	bank := prepareStudioLR4(rate, cutoff)
	warmup := int(math.Ceil(rate * .25))
	count := max(256, int(math.Ceil(16*rate/frequency)))
	input, low, high := complex(0, 0), complex(0, 0), complex(0, 0)
	for frame := range warmup + count {
		angle := 2 * math.Pi * frequency * float64(frame) / rate
		x := math.Sin(angle)
		_, l, h := bank.process(0, x)
		if frame >= warmup {
			window := .5 - .5*math.Cos(2*math.Pi*float64(frame-warmup)/float64(count-1))
			weight := complex(window*math.Cos(angle), -window*math.Sin(angle))
			input += complex(x, 0) * weight
			low += complex(l, 0) * weight
			high += complex(h, 0) * weight
		}
	}
	return low / input, high / input
}

func TestStudioLR4ActualCutoffMagnitudePhaseAndReconstruction(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, cutoff := range []float64{20, 120, 1000} {
			low, high := studioLR4Tone(rate, cutoff, cutoff)
			lowDB, highDB := 20*math.Log10(cmplx.Abs(low)), 20*math.Log10(cmplx.Abs(high))
			if math.Abs(lowDB+6.020599913) > .1 || math.Abs(highDB+6.020599913) > .1 || math.Abs(cmplx.Phase(low/high)*180/math.Pi) > 1 {
				t.Fatalf("rate %g cutoff %g LR4 branches %g/%g dB phase %g", rate, cutoff, lowDB, highDB, cmplx.Phase(low/high)*180/math.Pi)
			}
			for _, frequency := range []float64{cutoff / 4, cutoff, cutoff * 4} {
				if frequency >= rate*.49 {
					continue
				}
				low, high = studioLR4Tone(rate, cutoff, frequency)
				if math.Abs(20*math.Log10(cmplx.Abs(low+high))) > .1 {
					t.Fatal("LR4 all-pass reconstruction changed magnitude")
				}
				ratio := math.Tan(math.Pi*frequency/rate) / math.Tan(math.Pi*cutoff/rate)
				power := ratio * ratio * ratio * ratio
				want := power / (1 + power)
				if math.Abs(20*math.Log10(cmplx.Abs(high)/want)) > .1 {
					t.Fatalf("rate %g cutoff %g frequency %g high branch does not follow LR4", rate, cutoff, frequency)
				}
			}
		}
	}
}

func TestStudioLR4FiniteDCAndNoProcessingAllocations(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, cutoff := range []float64{20, 1000} {
			bank := prepareStudioLR4(rate, cutoff)
			mid, low, high := 0.0, 0.0, 0.0
			for range int(rate * .3) {
				mid, low, high = bank.process(1, .5)
			}
			if math.Abs(mid-1) > 1e-6 || math.Abs(low-.5) > 1e-6 || math.Abs(high) > 1e-6 {
				t.Fatal("LR4 DC does not settle to unity low/all-pass and zero high")
			}
			for _, x := range []float64{math.MaxFloat32, -math.MaxFloat32, 0} {
				m, l, h := bank.process(x, -x)
				if !finite(m) || !finite(l) || !finite(h) {
					t.Fatal("LR4 nonfinite overload")
				}
			}
		}
	}
	bank := prepareStudioLR4(48000, 120)
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			bank.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("LR4 processing allocated")
	}
}
