package dsp

import (
	"math"
	"testing"
)

func studioAnalyticIntervalPeak(frequency, phase float64, frame int64) float64 {
	start, end := float64(frame), float64(frame+1)
	peak := math.Max(math.Abs(math.Sin(2*math.Pi*frequency*start+phase)), math.Abs(math.Sin(2*math.Pi*frequency*end+phase)))
	first := int(math.Ceil((2*math.Pi*frequency*start + phase - math.Pi/2) / math.Pi))
	last := int(math.Floor((2*math.Pi*frequency*end + phase - math.Pi/2) / math.Pi))
	if first <= last {
		peak = 1
	}
	return peak
}

func TestStudioPeakDetectorIndexedIntervalsAgainstAnalyticSines(t *testing.T) {
	kernel := prepareStudioPeakKernel()
	worstUnder, worstOver := 0.0, 0.0
	for _, frequency := range []float64{1.0 / 8, 1.0 / 6, .25, 1.0 / 3, .4, .45, .49} {
		for _, phase := range []float64{0, math.Pi / 16, math.Pi / 4, 3 * math.Pi / 8} {
			detector := studioPeakDetector{}
			for sample := range 2048 {
				x := math.Sin(2*math.Pi*frequency*float64(sample) + phase)
				frame, peak := detector.process(&kernel, x, x*.5)
				if frame != int64(sample-studioPeakAvailability) {
					t.Fatal("detector peak timestamp omitted FIR/refined availability delay")
				}
				if frame < 512 {
					continue
				}
				want := studioAnalyticIntervalPeak(frequency, phase, frame)
				errorDB := 20 * math.Log10(peak/want)
				worstUnder, worstOver = math.Min(worstUnder, errorDB), math.Max(worstOver, errorDB)
				if !finite(errorDB) || errorDB < -.02 || errorDB > .02 {
					t.Fatalf("frequency %g phase %g frame %d detector %g analytic %g error %g dB", frequency, phase, frame, peak, want, errorDB)
				}
			}
		}
	}
	t.Logf("indexed4x FIR/refined peak intervals versus analytic sines through.49Fs: %g..%g dB", worstUnder, worstOver)
}

func TestStudioPeakDetectorImpulseTimingDCAndNoAllocations(t *testing.T) {
	kernel, detector := prepareStudioPeakKernel(), studioPeakDetector{}
	peak, at := 0.0, int64(-1000)
	for frame := range 1024 {
		input := 0.0
		if frame == 0 {
			input = 1
		}
		index, value := detector.process(&kernel, input, input)
		if value > peak {
			peak, at = value, index
		}
	}
	if math.Abs(peak-1) > .001 || (at != 0 && at != -1) {
		t.Fatalf("impulse detector peak %g at interval %d", peak, at)
	}
	detector = studioPeakDetector{}
	for range 1024 {
		detector.process(&kernel, .5, -.25)
	}
	_, value := detector.process(&kernel, .5, -.25)
	if math.Abs(value-.5) > 1e-12 {
		t.Fatal("detector interpolation phases changed steady DC gain")
	}
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			detector.process(&kernel, .2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("indexed peak detector allocated")
	}
}

func TestStudioPeakExtremaFindsBetweenPhaseExtremum(t *testing.T) {
	peak := studioRefinedPeak(-.9, -.5, .8, .8, -.5, -.9)
	if peak < .95 || peak > 1.2 {
		t.Fatal("cubic detector ignored a peak between sampled phases")
	}
	if studioRefinedPeak(.5, .5, .5, .5, .5, .5) != .5 {
		t.Fatal("cubic steady value changed")
	}
}

func BenchmarkStudioPeakDetectorBlock(b *testing.B) {
	kernel, detector := prepareStudioPeakKernel(), studioPeakDetector{}
	var input [128][2]float64
	for frame := range input {
		input[frame][0] = .7*math.Sin(float64(frame)*.231) + .2*math.Cos(float64(frame)*.117)
		input[frame][1] = .6*math.Sin(float64(frame)*.193) - .1*math.Cos(float64(frame)*.087)
	}
	for range 16 {
		for _, sample := range input {
			detector.process(&kernel, sample[0], sample[1])
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		for _, sample := range input {
			detector.process(&kernel, sample[0], sample[1])
		}
	}
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(input)), "ns/frame")
}
