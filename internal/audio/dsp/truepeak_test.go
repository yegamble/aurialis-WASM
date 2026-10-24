package dsp

import (
	"context"
	"fmt"
	"math"
	"testing"
)

func truePeakParams(ceiling float64) Params {
	p := DefaultParams()
	p.AlgorithmVersion = TruePeakAlgorithmVersion
	p.Limiter.Enabled, p.Limiter.TruePeak = true, true
	p.Limiter.CeilingDBTP = ceiling
	return p
}

// truePeakFixtures are signals whose reconstructed peaks sit well above their
// sample peaks or drive the limiter hard: an fs/4 sine at pi/4 (+3.01 dB of
// inter-sample overshoot), hot deterministic noise, and a near-Nyquist square.
func truePeakFixtures(rate float64) map[string][2][]float32 {
	n := int(rate * 0.25)
	fixtures := map[string][2][]float32{}
	quarter := make([]float32, n)
	for i := range quarter {
		quarter[i] = float32(1.4 * math.Sin(math.Pi*float64(i)/2+math.Pi/4))
	}
	fixtures["fs/4"] = [2][]float32{quarter, quarter}
	left, right := make([]float32, n), make([]float32, n)
	state := uint32(0x12345678)
	for i := range left {
		state = state*1664525 + 1013904223
		left[i] = float32(2*float64(state)/math.MaxUint32 - 1)
		state = state*1664525 + 1013904223
		right[i] = float32(2*float64(state)/math.MaxUint32 - 1)
	}
	fixtures["noise"] = [2][]float32{left, right}
	square := make([]float32, n)
	for i := range square {
		square[i] = 1
		if (i/3)%2 == 1 {
			square[i] = -1
		}
	}
	fixtures["square"] = [2][]float32{square, quarter}
	return fixtures
}

func TestTruePeakLimiterBoundsReconstructedPeaks(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000, 192000} {
		for name, fixture := range truePeakFixtures(rate) {
			for _, ceiling := range []float64{-1, -0.1, -6} {
				t.Run(fmt.Sprintf("%.0f/%s/%g", rate, name, ceiling), func(t *testing.T) {
					p := truePeakParams(ceiling)
					p.InputGainDB = 6
					outL, outR, metrics, err := RenderBufferContext(context.Background(), fixture[0], fixture[1], rate, p)
					if err != nil {
						t.Fatal(err)
					}
					if len(outL) != len(fixture[0]) || len(outR) != len(fixture[1]) {
						t.Fatal("render changed length")
					}
					if metrics.TruePeakDBTP > ceiling {
						t.Fatalf("true peak %.4f dBTP exceeds %g dBTP ceiling", metrics.TruePeakDBTP, ceiling)
					}
					if metrics.TruePeakDBTP < ceiling-1.5 {
						t.Fatalf("true peak %.4f dBTP over-limits a %g dBTP ceiling", metrics.TruePeakDBTP, ceiling)
					}
				})
			}
		}
	}
}

func TestLegacyLimiterStillMissesInterSamplePeaks(t *testing.T) {
	// v1 is frozen; this documents why v2 exists rather than certifying v1.
	quarter := truePeakFixtures(48000)["fs/4"][0]
	p := truePeakParams(-1)
	p.AlgorithmVersion = LegacyAlgorithmVersion
	_, _, metrics, err := RenderBufferContext(context.Background(), quarter, quarter, 48000, p)
	if err != nil {
		t.Fatal(err)
	}
	if metrics.TruePeakDBTP < 0 {
		t.Fatalf("v1 true peak %.3f dBTP; fixture no longer shows the sample-peak limitation", metrics.TruePeakDBTP)
	}
}

func TestTruePeakBelowCeilingMatchesLegacyAligned(t *testing.T) {
	// Below the ceiling v2 applies unity gain, so after latency compensation it
	// must reproduce v1 bit for bit. Dither is excluded: its noise sequence also
	// covers the lookahead's leading frames and is therefore offset by design.
	left, right := generateToneStereo(48000, 997, 0.3, 0.3, 0.2)
	p := truePeakParams(-1)
	p.Bands[2].GainDB, p.Saturation.Amount, p.Stereo.WidthPct = 2, 15, 115
	legacy := p
	legacy.AlgorithmVersion = LegacyAlgorithmVersion
	wantL, wantR, _, err := RenderBufferContext(context.Background(), left, right, 48000, legacy)
	if err != nil {
		t.Fatal(err)
	}
	gotL, gotR, _, err := RenderBufferContext(context.Background(), left, right, 48000, p)
	if err != nil {
		t.Fatal(err)
	}
	for i := range wantL {
		if gotL[i] != wantL[i] || gotR[i] != wantR[i] {
			t.Fatalf("aligned v2 differs from v1 at frame %d", i)
		}
	}
}

func TestTruePeakBypassIsDelayedBitIdentical(t *testing.T) {
	left, right := generateToneStereo(44100, 440, 1.3, 0.1, 0.3)
	left[7] = float32(math.NaN())
	p := truePeakParams(-1)
	p.Bypass = true
	outL, outR, _, err := RenderBufferContext(context.Background(), left[8:], right[8:], 44100, p)
	if err != nil {
		t.Fatal(err)
	}
	for i := range outL {
		if outL[i] != left[i+8] || outR[i] != right[i+8] {
			t.Fatalf("v2 bypass changed frame %d", i)
		}
	}
	e := NewEngine(44100)
	e.SetParams(p)
	out := make([]float32, 16)
	e.ProcessBlock(left[:16], right[:16], out, out[:16])
	if out[7] != 0 {
		// Frame 7 is still inside the lookahead; it must not be NaN-poisoned later either.
		t.Fatal("lookahead emitted source audio early")
	}
}

func TestTruePeakStreamingMatchesRenderWithDrain(t *testing.T) {
	for _, rate := range []float64{8000, 48000, 192000} {
		fixture := truePeakFixtures(rate)["noise"]
		p := truePeakParams(-1)
		p.Compressor.ThresholdDB, p.Compressor.Ratio = -12, 3
		p.LoudnessMatchAB, p.DitherBits = true, 24
		wantL, wantR, _, err := RenderBufferContext(context.Background(), fixture[0], fixture[1], rate, p)
		if err != nil {
			t.Fatal(err)
		}
		e := NewEngine(rate)
		e.SetParams(p)
		latency := e.LatencyFrames()
		if latency != int(math.Round(rate*truePeakAttackSeconds))+truePeakSupport || e.AlgorithmVersion() != TruePeakAlgorithmVersion {
			t.Fatalf("%g Hz latency %d", rate, latency)
		}
		n := len(fixture[0])
		gotL, gotR := make([]float32, n+latency), make([]float32, n+latency)
		for start := 0; start < n; start += 127 {
			end := min(start+127, n)
			e.ProcessBlock(fixture[0][start:end], fixture[1][start:end], gotL[start:end], gotR[start:end])
		}
		// Drain in two partial calls; the second must finish exactly the latency.
		first := e.Drain(gotL[n:n+5], gotR[n:n+5])
		second := e.Drain(gotL[n+first:], gotR[n+first:])
		if first != 5 || first+second != latency || e.Drain(gotL, gotR) != 0 {
			t.Fatalf("%g Hz drained %d+%d of %d", rate, first, second, latency)
		}
		for i := range wantL {
			if gotL[i+latency] != wantL[i] || gotR[i+latency] != wantR[i] {
				t.Fatalf("%g Hz streaming/render mismatch at %d", rate, i)
			}
		}
	}
}

func TestTruePeakShortInputDrainsWholeLatency(t *testing.T) {
	p := truePeakParams(-1)
	in := []float32{0.5, -0.25, 0.125}
	outL, outR, _, err := RenderBufferContext(context.Background(), in, in, 48000, p)
	if err != nil {
		t.Fatal(err)
	}
	for i := range in {
		if outL[i] != in[i] || outR[i] != in[i] {
			t.Fatalf("short input frame %d = %g, want %g", i, outL[i], in[i])
		}
	}
}

func TestTruePeakReportsGainReductionAndResets(t *testing.T) {
	quarter := truePeakFixtures(48000)["fs/4"][0]
	e := NewEngine(48000)
	e.SetParams(truePeakParams(-1))
	out := make([]float32, len(quarter))
	e.ProcessBlock(quarter, quarter, out, out)
	// 1.4 linear reconstructs to +2.92 dBTP; -1 dBTP needs about 3.9 dB.
	if gr := e.LastGainReductionDB(); gr < 3.5 || gr > 4.5 {
		t.Fatalf("gain reduction %.3f dB", gr)
	}
	legacy := e.Params()
	legacy.AlgorithmVersion = LegacyAlgorithmVersion
	e.SetParams(legacy)
	if e.LatencyFrames() != 0 || e.truePeak.pending != 0 || e.Drain(out, out) != 0 {
		t.Fatal("switching to v1 kept buffered v2 audio")
	}
	e.SetParams(truePeakParams(-1))
	e.Reset()
	silence := make([]float32, 256)
	e.ProcessBlock(silence, silence, out[:256], out[:256])
	for _, v := range out[:256] {
		if v != 0 {
			t.Fatal("reset leaked lookahead audio")
		}
	}
}

func TestTruePeakProcessingDoesNotAllocate(t *testing.T) {
	fixture := truePeakFixtures(96000)["noise"]
	e := NewEngine(96000)
	e.SetParams(truePeakParams(-1))
	outL, outR := make([]float32, 512), make([]float32, 512)
	if allocations := testing.AllocsPerRun(10, func() {
		e.ProcessBlock(fixture[0][:512], fixture[1][:512], outL, outR)
		e.Drain(outL, outR)
	}); allocations != 0 {
		t.Fatalf("v2 processing allocated %g", allocations)
	}
}

// referenceTruePeakDB is an independent 32x, 128-tap Kaiser-windowed sinc
// reconstruction, evaluated away from the buffer edges so truncation of the
// buffer itself cannot ring. It shares no code with truePeakFIR or peakFIR.
func referenceTruePeakDB(channels [][]float32, edge int) float64 {
	const phases, half, beta = 32, 64, 10.0
	bessel := func(x float64) float64 {
		sum, term := 1.0, 1.0
		for k := 1; k < 50; k++ {
			term *= x / 2 / float64(k)
			sum += term * term
		}
		return sum
	}
	var kernel [phases][2 * half]float64
	for p := range kernel {
		for k := range kernel[p] {
			d := float64(k-half+1) - float64(p)/phases
			sinc := 1.0
			if d != 0 {
				sinc = math.Sin(math.Pi*d) / (math.Pi * d)
			}
			kernel[p][k] = sinc * bessel(beta*math.Sqrt(1-(d/half)*(d/half))) / bessel(beta)
		}
	}
	peak := 0.0
	for _, x := range channels {
		for i := edge; i < len(x)-edge; i++ {
			for p := range kernel {
				v := 0.0
				for k, c := range kernel[p] {
					if j := i + k - half + 1; j >= 0 && j < len(x) {
						v += c * float64(x[j])
					}
				}
				peak = math.Max(peak, math.Abs(v))
			}
		}
	}
	return linToDB(peak)
}

func TestTruePeakLimiterHoldsAgainstIndependentReference(t *testing.T) {
	// Program-like content with strong high-frequency energy: a decaying kick,
	// a 220 Hz tone and broadband noise, plus a 19 kHz or 0.45 fs tone. The
	// 49-tap 4x meter under-reads these near Nyquist, so a limiter driven by it
	// leaves real inter-sample overs; v2 must hold the reference under ceiling.
	for _, rate := range []float64{44100, 96000} {
		for _, hf := range []float64{0, 19000, 0.45 * rate} {
			t.Run(fmt.Sprintf("%.0f/%.0f", rate, hf), func(t *testing.T) {
				const n = 8000
				left, right := make([]float32, n), make([]float32, n)
				state := uint32(99)
				for i := range left {
					state = state*1664525 + 1013904223
					noise := 2*float64(state)/math.MaxUint32 - 1
					at := float64(i) / rate
					beat := math.Mod(at, 0.05)
					x := 0.8*math.Exp(-beat*60)*math.Sin(2*math.Pi*55*beat) + 0.3*math.Sin(2*math.Pi*220*at) + 0.25*noise + 0.2*math.Sin(2*math.Pi*hf*at)
					left[i], right[i] = float32(x), float32(0.9*x)
				}
				p := truePeakParams(-1)
				p.InputGainDB = 6
				outL, outR, _, err := RenderBufferContext(context.Background(), left, right, rate, p)
				if err != nil {
					t.Fatal(err)
				}
				if got := referenceTruePeakDB([][]float32{outL, outR}, 300); got > -1 {
					t.Fatalf("independent 32x reference %.3f dBTP exceeds -1 dBTP", got)
				}
			})
		}
	}
}
