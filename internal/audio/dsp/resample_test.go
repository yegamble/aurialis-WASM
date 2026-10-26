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

func TestResampleRejectsAliases(t *testing.T) {
	// 30 kHz at 96 kHz would alias to 14.1 kHz at 44.1 kHz.
	in := toneAt(96000, 30000, 0.9, 96000)
	l, _, err := ResampleContext(context.Background(), in, in, 96000, 44100)
	if err != nil {
		t.Fatal(err)
	}
	if alias := GoertzelMagnitudeDB(l, 44100, 14100) - 20*math.Log10(0.9); alias > -110 {
		t.Fatalf("alias at 14.1 kHz %.1f dB relative to the input tone, want below -110", alias)
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
					inL, inR := loudProgram(from/4, uint64(from)^uint64(to))
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
					t.Logf("delivered: 8x %.3f dBTP, 32x reference %.3f dBTP, 4x meter %.3f dBTP, sample peak %.3f dBFS, final reduction %.2f dB", detector, reference, metrics.TruePeakDBTP, metrics.SamplePeakDBFS, reduction)
					if detector > ceiling || reference > ceiling {
						t.Errorf("delivered true peak %.3f dBTP (32x reference %.3f) exceeds the %g dBTP ceiling", detector, reference, ceiling)
					}
					// The 49-tap BS.1770 4x meter can over-read strong content near
					// the Nyquist frequency of 88.2/96 kHz delivery (0.36 dB above
					// the 32x reference on half a second of this noise at
					// 96→88.2 kHz), so it is only held to the ceiling at 44.1/48 kHz.
					if to <= 48000 && metrics.TruePeakDBTP > ceiling {
						t.Errorf("4x meter %.3f dBTP exceeds the %g dBTP ceiling", metrics.TruePeakDBTP, ceiling)
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
