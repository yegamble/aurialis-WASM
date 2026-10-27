package dsp

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/truepeakref"
)

// V1-13: the true-peak meter behind export reports, Release Check and the live
// meter reads high-frequency sines at any phase within 0.1 dB of the long-sinc
// reference. The ratios have short exact periods, so a tone's peaks keep the
// same offsets from the 4x grid instead of sweeping across it. The 49-tap
// BS.1770-4 Annex 2 filter the meter replaced read these up to 0.44 dB low.
func TestTruePeakMeterReadsHighFrequencySinesWithinATenthOfADecibel(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, ratio := range []float64{0.05, 0.25, 0.375, 0.4, 0.4375, 0.45} {
			t.Run(fmt.Sprintf("%.0f/%.2ffs", rate, ratio), func(t *testing.T) {
				t.Parallel()
				worst, highest := 0.0, math.Inf(-1)
				for _, phase := range []float64{0, 0.4, 0.8, 1.3, 1.9, 2.6} {
					const n, taper = 6000, 1500
					left, right := make([]float32, n), make([]float32, n)
					for i := range left {
						fade := math.Min(1, 0.5-0.5*math.Cos(math.Pi*math.Min(float64(i), float64(n-1-i))/taper))
						left[i] = float32(0.5 * fade * math.Sin(2*math.Pi*ratio*float64(i)+phase))
						right[i] = float32(0.25 * fade * math.Sin(2*math.Pi*ratio*float64(i)+2*phase))
					}
					reference := truepeakref.PeakDBTP([][]float32{left, right}, 0)
					export := MeasureStereo(left, right, rate).TruePeakDBTP
					live := NewLoudnessMeter(rate)
					live.Process(left, right)
					for _, reading := range []float64{export, live.Snapshot().TruePeakDBTP} {
						worst = math.Min(worst, reading-reference)
						highest = math.Max(highest, reading-reference)
					}
				}
				if worst < -0.1 || highest > 0.02 {
					t.Fatalf("meter error %+.3f…%+.3f dB against the reference", worst, highest)
				}
			})
		}
	}
}

// nearNyquistProgram is dense content between 0.47 fs and Nyquist (noise
// mirrored to the top of the band, plus tones at 0.48 and 0.497 fs) over a
// bass line, peaking at -3 dBFS sample peak.
func nearNyquistProgram(rate float64, frames int) ([]float32, []float32) {
	left, right := make([]float64, frames), make([]float64, frames)
	state := uint32(0x51ed27)
	noise := func() float64 {
		state = state*1664525 + 1013904223
		return float64(state)/math.MaxUint32*2 - 1
	}
	var narrowL, narrowR float64
	for i := range left {
		sign := 1 - 2*float64(i%2)
		// A one-pole low-pass near 0.015 fs, mirrored to 0.485-0.5 fs.
		narrowL += 0.09 * (noise() - narrowL)
		narrowR += 0.09 * (noise() - narrowR)
		at := float64(i)
		hf := 0.15*math.Sin(2*math.Pi*0.48*at+0.3) + 0.12*math.Sin(2*math.Pi*0.497*at+1.1)
		bass := 0.3 * math.Sin(2*math.Pi*55*at/rate)
		left[i] = bass + hf + 1.2*sign*narrowL
		right[i] = 0.8*bass - hf + 1.2*sign*narrowR
	}
	peak := 0.0
	for i := range left {
		peak = math.Max(peak, math.Max(math.Abs(left[i]), math.Abs(right[i])))
	}
	scale := math.Pow(10, -3.0/20) / peak
	outL, outR := make([]float32, frames), make([]float32, frames)
	for i := range left {
		outL[i], outR[i] = float32(left[i]*scale), float32(right[i]*scale)
	}
	return outL, outR
}

// V1-13 Round E R5 (Chair): the export and Release Check meter
// (MeasureStereo) reads within 0.1 dB of the long-sinc reference on all
// content, including an unlimited export dense between 0.47 fs and Nyquist.
// The live display meter keeps a 48-tap kernel and under-reads such content;
// it is held to 0.1 dB only on limited exports (true_peak_ceiling_test.go).
func TestExportMeterReadsUnlimitedNearNyquistContent(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		t.Run(fmt.Sprintf("%.0f", rate), func(t *testing.T) {
			t.Parallel()
			left, right := nearNyquistProgram(rate, int(3*rate)) // several transform blocks
			p := DefaultParams()
			p.AlgorithmVersion = TruePeakAlgorithmVersion
			p.Limiter.Enabled = false
			p.Bands[2].GainDB = 1 // a live chain, not bypass
			outL, outR, metrics, err := RenderBufferContext(context.Background(), left, right, rate, p)
			if err != nil {
				t.Fatal(err)
			}
			reference := truepeakref.PeakDBTP([][]float32{outL, outR}, 0)
			live := NewLoudnessMeter(rate)
			live.Process(outL, outR)
			display := live.Snapshot().TruePeakDBTP
			t.Logf("%.0f Hz: reference %+.3f dBTP, export meter %+.3f (%+.3f), live display %+.3f (%+.3f)", rate, reference, metrics.TruePeakDBTP, metrics.TruePeakDBTP-reference, display, display-reference)
			if diff := metrics.TruePeakDBTP - reference; diff < -0.1 || diff > 0.02 {
				t.Fatalf("export meter %.3f dBTP against reference %.3f dBTP", metrics.TruePeakDBTP, reference)
			}
		})
	}
}

// crestStart is the Round E 2 probe: 0.5·cos(2π f i + φ)·e^(−i/400) over
// 3000 frames, starting on (or near) a crest; reversed, it ends on one.
func crestStart(ratio, phase float64, reversed bool) []float32 {
	const n = 3000
	x := make([]float32, n)
	for i := range x {
		at := i
		if reversed {
			at = n - 1 - i
		}
		x[i] = float32(0.5 * math.Cos(2*math.Pi*ratio*float64(at)+phase) * math.Exp(-float64(at)/400))
	}
	return x
}

// V1-13 Round E 2 R-A: a file that starts or ends on a crest reads within
// 0.1 dB of an independent time-domain reference (a ±1024-tap sinc over the
// zero-extended file, before its first frame and after its last). The export
// meter once fitted its first parabola through a fake zero and read up to
// 0.79 dB high (the Devil's Advocate's decaying cosine, the RED trigger here)
// and a 1-frame file 0.766 dB high (QA-6).
func TestExportMeterReadsFilesThatStartOrEndOnACrest(t *testing.T) {
	type edgeCase struct {
		name string
		x    []float32
	}
	var cases []edgeCase
	for _, ratio := range []float64{0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.47} {
		for _, phase := range []float64{0, 0.2, 0.5, 1.0} {
			for _, reversed := range []bool{false, true} {
				cases = append(cases, edgeCase{fmt.Sprintf("%.2ffs/%.1f/reversed=%t", ratio, phase, reversed), crestStart(ratio, phase, reversed)})
			}
		}
	}
	for _, at := range []int{0, 37, 63} {
		lone := make([]float32, 64)
		lone[at] = 0.9
		cases = append(cases, edgeCase{fmt.Sprintf("sample %d of 64", at), lone})
	}
	// QA-6: a 1-frame file once read 0.766 dB high, the same fake-zero fit.
	cases = append(cases, edgeCase{"1-frame file", []float32{0.9}}, edgeCase{"2-frame file", []float32{0.9, -0.6}})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			reference := truepeakref.DirectPeakDBTP([][]float32{c.x})
			for _, rate := range []float64{44100, 96000} {
				got := MeasureStereo(c.x, c.x, rate).TruePeakDBTP
				t.Logf("%.0f Hz: export meter %+.4f dB against the reference", rate, got-reference)
				if diff := got - reference; diff < -0.1 || diff > 0.02 {
					t.Fatalf("%.0f Hz: export meter %.3f dBTP against reference %.3f dBTP (%+.3f dB)", rate, got, reference, diff)
				}
			}
		})
	}
}

// nyquistFlip is QA's V1-13 probe: a full-scale alternation at exactly
// Nyquist whose polarity flips halfway. Its true peak, at the flip, grows
// like (2/π)·ln N with the run length, so no finite context reads it.
func nyquistFlip(frames int) ([]float32, []float32) {
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		s := float32(1)
		if i%2 == 1 {
			s = -s
		}
		if i >= frames/2 {
			s = -s
		}
		left[i], right[i] = s, -s
	}
	return left, right
}

// V1-13 Round E 2 QA-1 (Chair ruling): the export meter's one documented
// exception is sustained coherent energy within about fs/16384 of Nyquist.
// It pins the bound: a flip run that fits one transform reads within 0.1 dB,
// and a longer one reads at least what the meter's 8,192 frames of context on
// each side reconstruct, never more than the full reconstruction.
func TestExportMeterNyquistFlipBound(t *testing.T) {
	const rate = 44100.0
	shortL, shortR := nyquistFlip(2 * offlinePeakGuard)
	contextPeak := truepeakref.PeakDBTP([][]float32{shortL, shortR}, 0)
	lengths := []float64{1, 4, 10}
	if raceEnabled {
		lengths = []float64{1, 4}
	}
	for _, seconds := range lengths {
		left, right := nyquistFlip(int(rate * seconds))
		reference := truepeakref.PeakDBTP([][]float32{left, right}, 0)
		got := MeasureStereo(left, right, rate).TruePeakDBTP
		t.Logf("%.0f s: reference %+.3f dBTP, export meter %+.3f dBTP (under-read %.3f dB); 8,192-frame context %+.3f dBTP", seconds, reference, got, reference-got, contextPeak)
		switch {
		case got > reference+0.02:
			t.Fatalf("%.0f s: export meter over-reads by %.3f dB", seconds, got-reference)
		case seconds == 1 && got < reference-0.1:
			t.Fatalf("1 s fits one transform but reads %.3f dB low", reference-got)
		case got < contextPeak-0.1:
			t.Fatalf("%.0f s: export meter %.3f dBTP is below its 8,192-frame context %.3f dBTP", seconds, got, contextPeak)
		}
	}
}
