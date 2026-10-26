package dsp

import (
	"context"
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
	if err := FinishResampled(l, r, 44100, p); err != nil {
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
