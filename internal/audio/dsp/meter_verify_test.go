package dsp

import (
	"math"
	"testing"
)

func TestMeterAgainstFFmpegEBUR128Reference(t *testing.T) {
	// Independent references executed with FFmpeg's ebur128=peak=true on stereo
	// f32le fixtures at each rate (FFmpeg 7.1.1). Integrated summary precision is
	// 0.1 LU: tone=-20.0, gated=-20.2; tapered fs/4 sine peak=0.0 dBFS.
	// No FFmpeg executable or external dependency is required by this unit suite.
	for _, rate := range []float64{44100, 48000, 96000} {
		tone, _ := generateToneStereo(rate, 997, 0.1, 3, 0)
		meter := MeasureStereo(tone, tone, rate)
		if math.Abs(meter.IntegratedLUFS-(-20)) > 0.1 {
			t.Fatalf("%g Hz tone integrated=%g, FFmpeg=-20.0", rate, meter.IntegratedLUFS)
		}
		if math.Abs(meter.ShortTermLUFS-(-20)) > 0.1 {
			t.Fatalf("%g Hz tone short-term=%g, FFmpeg=-20.0", rate, meter.ShortTermLUFS)
		}
		gate := make([]float32, int(rate*9))
		for i := range gate {
			amplitude := 0.1
			if i >= int(rate*3) {
				amplitude = 0
			}
			if i >= int(rate*6) {
				amplitude = 0.001
			}
			gate[i] = float32(amplitude * math.Sin(2*math.Pi*997*float64(i)/rate))
		}
		meter = MeasureStereo(gate, gate, rate)
		if math.Abs(meter.IntegratedLUFS-(-20.2)) > 0.1 {
			t.Fatalf("%g Hz gated integrated=%g, FFmpeg=-20.2", rate, meter.IntegratedLUFS)
		}
		if math.Abs(meter.ShortTermLUFS-(-60)) > 0.1 {
			t.Fatalf("%g Hz trailing3s=%g, expected-60.0", rate, meter.ShortTermLUFS)
		}
		peak := make([]float32, int(rate*3))
		for i := range peak {
			taper := math.Min(1, math.Min(float64(i)/100, float64(len(peak)-1-i)/100))
			peak[i] = float32(taper * math.Sin(math.Pi*float64(i)/2+math.Pi/4))
		}
		meter = MeasureStereo(peak, peak, rate)
		if math.Abs(meter.TruePeakDBTP) > 0.1 {
			t.Fatalf("%g Hz reconstructed peak=%g, FFmpeg=0.0", rate, meter.TruePeakDBTP)
		}
		if math.Abs(meter.SamplePeakDBFS-(-3.0103)) > 0.001 {
			t.Fatal("fs/4 fixture sampled peak changed")
		}
	}
}

func TestLoudnessSumsStereoChannelsAndRejectsSilence(t *testing.T) {
	tone, _ := generateToneStereo(48000, 997, 0.1, 1, 0)
	silence := make([]float32, len(tone))
	mono := MeasureStereo(tone, silence, 48000)
	stereo := MeasureStereo(tone, tone, 48000)
	if math.Abs(stereo.IntegratedLUFS-mono.IntegratedLUFS-10*math.Log10(2)) > 1e-8 {
		t.Fatal("BS.1770 stereo channel weighting is not additive")
	}
	meter := MeasureStereo(silence, silence, 48000)
	if meter.IntegratedLUFS != -70 || meter.ShortTermLUFS != -70 {
		t.Fatal("silence did not return finite meter floor")
	}
}
