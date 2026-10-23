package dsp

import (
	"math"
	"testing"
)

func studioHalfBandResponse(c studioHalfBandCoeffs, frequency float64) float64 {
	realPart := .5
	for k, coefficient := range c.odd {
		realPart += coefficient * math.Cos(2*math.Pi*frequency*float64(2*k+1-64))
	}
	return math.Abs(realPart)
}

func TestStudioHalfBandMeasuredPassbandAndStopband(t *testing.T) {
	c := prepareStudioHalfBand()
	passMinimum, passMaximum, stopMaximum := 1.0, 1.0, 0.0
	for bin := range 16385 {
		frequency := float64(bin) / 32768
		response := studioHalfBandResponse(c, frequency)
		if frequency <= .227 {
			passMinimum, passMaximum = math.Min(passMinimum, response), math.Max(passMaximum, response)
		}
		if frequency >= .273 {
			stopMaximum = math.Max(stopMaximum, response)
		}
	}
	minimumDB, maximumDB, stopDB := 20*math.Log10(passMinimum), 20*math.Log10(passMaximum), 20*math.Log10(stopMaximum)
	if minimumDB < -.1 || maximumDB > .1 || stopDB > -60 {
		t.Fatalf("129-tap beta9 prototype pass %g/%g dB stop %g dB", minimumDB, maximumDB, stopDB)
	}
	t.Logf("129-tap beta9 prototype: pass <=.227 cycles/sample %g..%g dB; stop >=.273 %g dB", minimumDB, maximumDB, stopDB)
}

func TestStudioOversamplerImpulseMeasuresIntegerLatencyAndTail(t *testing.T) {
	c := prepareStudioHalfBand()
	s := studioOversamplerState{}
	var response [512]float64
	maximum, peak, sum, firstMoment := 0.0, 0, 0.0, 0.0
	for frame := range response {
		input := 0.0
		if frame == 0 {
			input = 1
		}
		response[frame] = s.decimate(&c, s.interpolate(&c, input))
		if math.Abs(response[frame]) > maximum {
			maximum, peak = math.Abs(response[frame]), frame
		}
		sum += response[frame]
		firstMoment += float64(frame) * response[frame]
	}
	if peak != studioOversamplingLatency || math.Abs(firstMoment/sum-float64(studioOversamplingLatency)) > 1e-10 || math.Abs(sum-1) > 1e-12 {
		t.Fatalf("measured impulse peak %d centroid %g sum %g", peak, firstMoment/sum, sum)
	}
	for i := 0; i <= studioOversamplingTail; i++ {
		if math.Abs(response[i]-response[studioOversamplingTail-i]) > 1e-12 {
			t.Fatal("actual round-trip impulse is not centered at declared delay")
		}
	}
	for _, value := range response[studioOversamplingTail+1:] {
		if value != 0 {
			t.Fatal("FIR has output beyond its declared finite tail")
		}
	}
	for _, frequency := range []float64{.001, .01, .1, .2, .3, .4, .45} {
		realPart, imaginaryPart := 0.0, 0.0
		for frame, value := range response {
			angle := 2 * math.Pi * frequency * float64(frame-studioOversamplingLatency)
			realPart += value * math.Cos(angle)
			imaginaryPart += value * math.Sin(angle)
		}
		if math.Abs(20*math.Log10(math.Hypot(realPart, imaginaryPart))) > .1 || math.Abs(imaginaryPart) > 1e-10 {
			t.Fatalf("round-trip response at %g not unity/declared linear phase", frequency)
		}
	}
	t.Logf("actual 4x round-trip group delay %d frames, finite support 0..%d", peak, studioOversamplingTail)
}

func TestStudioOversamplerDCPhasesAndNoProcessingAllocations(t *testing.T) {
	c, s := prepareStudioHalfBand(), studioOversamplerState{}
	for range 256 {
		samples := s.interpolate(&c, .25)
		s.decimate(&c, samples)
	}
	for _, sample := range s.interpolate(&c, .25) {
		if math.Abs(sample-.25) > 1e-14 {
			t.Fatal("interpolation phases have unequal DC gain")
		}
	}
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			s.decimate(&c, s.interpolate(&c, .25))
		}
	}); allocations != 0 {
		t.Fatal("oversampling allocated during processing")
	}
}
