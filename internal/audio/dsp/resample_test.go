package dsp

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"
)

func toneAt(rate, freq, amp float64, frames int) []float32 {
	out := make([]float32, frames)
	for i := range out {
		out[i] = float32(amp * math.Sin(2*math.Pi*freq*float64(i)/rate))
	}
	return out
}

func TestResamplePassbandAlignmentAndLength(t *testing.T) {
	for _, c := range []struct{ from, to int }{{44100, 48000}, {48000, 44100}, {96000, 44100}, {192000, 44100}, {32000, 48000}, {44100, 96000}, {48000, 88200}} {
		frames := c.from
		for _, f := range []float64{100, 1000, 10000, 19000} {
			if f > 0.9*0.5*float64(min(c.from, c.to)) {
				continue
			}
			in := toneAt(float64(c.from), f, 0.5, frames)
			l, r, err := ResampleContext(context.Background(), in, in, c.from, c.to)
			if err != nil {
				t.Fatal(err)
			}
			if want := (frames*c.to + c.from - 1) / c.from; len(l) != want || len(r) != want {
				t.Fatalf("%d→%d: %d frames, want %d", c.from, c.to, len(l), want)
			}
			// Away from the edges the output must equal the same tone sampled at the new rate.
			ideal := toneAt(float64(c.to), f, 0.5, len(l))
			var errSum, sigSum float64
			for i := len(l) / 4; i < 3*len(l)/4; i++ {
				d := float64(l[i] - ideal[i])
				errSum += d * d
				sigSum += float64(ideal[i]) * float64(ideal[i])
			}
			if snr := 10 * math.Log10(sigSum/errSum); snr < 90 {
				t.Errorf("%d→%d at %g Hz: aligned SNR %.1f dB, want ≥ 90", c.from, c.to, f, snr)
			}
		}
	}
}

// fadedTone is a Hann-enveloped tone, so its spectrum has no broadband edges
// that the conversion filter would pass next to the alias being measured.
func fadedTone(rate, freq float64, frames int) []float32 {
	out := toneAt(rate, freq, 0.9, frames)
	for i := range out {
		out[i] *= float32(0.5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(frames-1))))
	}
	return out
}

func TestResampleRejectsAliases(t *testing.T) {
	// Tones just past the lower Nyquist frequency, in the transition band,
	// fold back next to it; 30 kHz at 96 kHz would alias to 14.1 kHz at 44.1 kHz.
	// Every alias must sit at least the 120 dB design stopband below the tone.
	for _, c := range []struct{ from, to, freq float64 }{
		{48000, 44100, 22100}, {48000, 44100, 23000}, {96000, 44100, 22100}, {96000, 88200, 44200}, {96000, 44100, 30000},
	} {
		in := fadedTone(c.from, c.freq, int(c.from))
		l, _, err := ResampleContext(context.Background(), in, in, int(c.from), int(c.to))
		if err != nil {
			t.Fatal(err)
		}
		alias := c.to - c.freq
		reference := fadedTone(c.to, alias, len(l))
		got := GoertzelMagnitudeDB(l, c.to, alias) - GoertzelMagnitudeDB(reference, c.to, alias)
		t.Logf("%g→%g Hz: %g Hz tone aliases to %g Hz at %.1f dB", c.from, c.to, c.freq, alias, got)
		if got > -resampleStopbandDB {
			t.Errorf("%g→%g Hz: alias of %g Hz at %g Hz is %.1f dB relative to the tone, want ≤ -120", c.from, c.to, c.freq, alias, got)
		}
	}
}

func TestResampleRejectsUnsupportedRates(t *testing.T) {
	for _, c := range []struct{ from, to int }{{44100, 22050}, {7999, 48000}, {48000, 192000}, {48000, 0}} {
		if _, _, err := ResampleContext(context.Background(), []float32{0}, []float32{0}, c.from, c.to); err == nil {
			t.Errorf("%d→%d was accepted", c.from, c.to)
		}
	}
	if _, _, err := ResampleContext(context.Background(), []float32{0}, nil, 44100, 48000); err == nil {
		t.Error("unequal channels were accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := ResampleContext(ctx, make([]float32, 9000), make([]float32, 9000), 44100, 48000); err == nil {
		t.Error("a canceled context was ignored")
	}
}

func TestFinishResampledCeilingAndGrid(t *testing.T) {
	p := DefaultParams()
	p.Limiter = LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 80}
	p.DitherBits = 16
	l := toneAt(44100, 997, 1, 44100)
	r := toneAt(44100, 997, 1, 44100)
	if _, err := FinishResampled(context.Background(), l, r, 44100, p); err != nil {
		t.Fatal(err)
	}
	ceiling := dbToLin(-1)
	for i := range l {
		for _, v := range []float64{float64(l[i]), float64(r[i])} {
			if k := v * 32768; math.Abs(k-math.Round(k)) > 1e-3 || math.Abs(v) > ceiling {
				t.Fatalf("frame %d: %v off the 16-bit grid or above the ceiling", i, v)
			}
		}
	}
}

func TestResampleSpeed(t *testing.T) {
	if testing.Short() {
		t.Skip("timing report")
	}
	in := toneAt(44100, 1000, 0.5, 44100*10)
	start := time.Now()
	if _, _, err := ResampleContext(context.Background(), in, in, 44100, 48000); err != nil {
		t.Fatal(err)
	}
	t.Logf("10 s stereo 44.1→48 kHz in %v", time.Since(start))
}

// loudProgram is clipped Gaussian noise: dense full-band material whose
// conversion moves reconstructed peaks onto new sample instants.
func loudProgram(frames int, seed uint64) ([]float32, []float32) {
	state := seed
	uniform := func() float64 {
		state = state*6364136223846793005 + 1442695040888963407
		return (float64(state>>11) + 0.5) / (1 << 53)
	}
	gaussian := func() float64 {
		return math.Sqrt(-2*math.Log(uniform())) * math.Cos(2*math.Pi*uniform())
	}
	clip := func(x float64) float32 { return float32(math.Max(-1, math.Min(1, x))) }
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		common := gaussian()
		left[i], right[i] = clip(0.45*(common+0.5*gaussian())), clip(0.45*(common+0.5*gaussian()))
	}
	return left, right
}

// detectorPeakDB reads the limiter's own 8x reconstruction, flushed at the end.
func detectorPeakDB(left, right []float32) float64 {
	var d truePeakDetector
	peak := 0.0
	for i := range left {
		peak = math.Max(peak, d.sample(float64(left[i]), float64(right[i])))
	}
	for range 2 * truePeakHalfTaps {
		peak = math.Max(peak, d.sample(0, 0))
	}
	return linToDB(peak)
}

func TestConvertedExportHoldsTruePeakCeiling(t *testing.T) {
	// A hot render through the source-rate limiter (v1, as the HTTP API runs
	// it), converted to every other export rate and finished there. The
	// limiter's 8x detector and the independent 32x reference must both read
	// at or below the ceiling with no epsilon: the delivery limiter targets
	// ceiling·0.995·10^(-0.2/20) (-1.243 dBTP here) on that detector, and 16-bit
	// TPDF dither adds at most 1.5 LSB (under 0.001 dB at that level).
	const ceiling = -1.0
	for _, from := range ExportSampleRates {
		for _, to := range ExportSampleRates {
			if from == to {
				continue
			}
			for _, truePeak := range []bool{true, false} {
				t.Run(fmt.Sprintf("%d-%d/truePeak=%t", from, to, truePeak), func(t *testing.T) {
					t.Parallel()
					inL, inR := loudProgram(from/4, math.Float64bits(float64(from)/float64(to)))
					p := DefaultParams()
					p.InputGainDB = 11
					p.Limiter = LimiterParams{Enabled: true, CeilingDBTP: ceiling, TargetLUFS: -14, ReleaseMS: 80, TruePeak: truePeak}
					renderedL, renderedR, _, err := RenderBufferContext(context.Background(), inL, inR, float64(from), p)
					if err != nil {
						t.Fatal(err)
					}
					left, right, err := ResampleContext(context.Background(), renderedL, renderedR, from, to)
					if err != nil {
						t.Fatal(err)
					}
					p.DitherBits = 16
					reduction, err := FinishResampled(context.Background(), left, right, float64(to), p)
					if err != nil {
						t.Fatal(err)
					}
					metrics := MeasureStereo(left, right, float64(to))
					detector := detectorPeakDB(left, right)
					reference := referenceTruePeakDB([][]float32{left, right}, 0)
					t.Logf("%d→%d Hz delivered: 8x %.3f dBTP, 32x reference %.3f dBTP, 4x meter %.3f dBTP, sample peak %.3f dBFS, final reduction %.2f dB", from, to, detector, reference, metrics.TruePeakDBTP, metrics.SamplePeakDBFS, reduction)
					if detector > ceiling || reference > ceiling {
						t.Errorf("delivered true peak %.3f dBTP (32x reference %.3f) exceeds the %g dBTP ceiling", detector, reference, ceiling)
					}
					// afterMetrics.truePeakDbtp is the 49-tap 4x meter, which is
					// less accurate than both references: on full-band noise it
					// has read up to 0.21 dB over the ceiling at 96→88.2 kHz and
					// 0.004 dB over at 44.1→48 kHz while they held it. It is only
					// bounded loosely here.
					if metrics.TruePeakDBTP > ceiling+0.3 {
						t.Errorf("4x meter %.3f dBTP is far above the %g dBTP ceiling", metrics.TruePeakDBTP, ceiling)
					}
					// Peaks are pulled under the ceiling by gain, so no sample
					// sits at the clip level.
					if metrics.SamplePeakDBFS > ceiling-0.1 {
						t.Errorf("sample peak %.3f dBFS sits at the %g dB clip level", metrics.SamplePeakDBFS, ceiling)
					}
					for i := range left {
						if k := float64(left[i]) * 32768; math.Abs(k-math.Round(k)) > 1e-3 {
							t.Fatalf("frame %d is off the 16-bit grid", i)
						}
					}
				})
			}
		}
	}
}

func TestFinishResampledWithoutLimiterNeverClips(t *testing.T) {
	// Without the limiter a converted export keeps its level, as an
	// unconverted one does: float output keeps overs, and integer output only
	// meets the encoder's full-scale clamp.
	over := toneAt(48000, 997, 1.4, 4800)
	p := DefaultParams()
	left, right := append([]float32(nil), over...), append([]float32(nil), over...)
	if _, err := FinishResampled(context.Background(), left, right, 48000, p); err != nil {
		t.Fatal(err)
	}
	for i := range left {
		if left[i] != over[i] || right[i] != over[i] {
			t.Fatalf("frame %d changed without limiter or dither", i)
		}
	}
	p.Limiter.Enabled = true
	p.Bypass = true
	if _, err := FinishResampled(context.Background(), left, right, 48000, p); err != nil {
		t.Fatal(err)
	}
	for i := range left {
		if left[i] != over[i] {
			t.Fatalf("frame %d limited during bypass", i)
		}
	}
	p.Bypass = false
	p.Limiter.Enabled = false
	p.DitherBits = 24
	if _, err := FinishResampled(context.Background(), left, right, 48000, p); err != nil {
		t.Fatal(err)
	}
	clamped := 0
	for i := range left {
		if want := math.Max(-1, math.Min(1-1.0/8388608, float64(over[i]))); math.Abs(float64(left[i])-want) > 2.0/8388608 {
			t.Fatalf("frame %d: %v, want %v within dither", i, left[i], want)
		}
		if math.Abs(float64(over[i])) >= 1 {
			clamped++
		}
	}
	if clamped == 0 {
		t.Fatal("fixture never reaches full scale")
	}
}
