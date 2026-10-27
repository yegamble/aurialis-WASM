package main

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/audio/truepeakref"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// nyquistTorture is a deterministic mix built to defeat short true-peak
// kernels: gated tones from 20 kHz to 0.498 fs, noise in the top 2% of the
// band, a naively hard-clipped 3 kHz tone whose aliased harmonics fill the
// spectrum, and a bass line. It peaks at -1 dBFS sample peak.
func nyquistTorture(rate float64, seconds int) ([]float32, []float32) {
	frames := int(rate) * seconds
	left, right := make([]float64, frames), make([]float64, frames)
	seed := uint32(0x2545f491)
	noise := func() float64 {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		return float64(seed)/2147483648 - 1
	}
	tones := []float64{20000, 21000, 0.47 * rate, 0.49 * rate, 0.498 * rate}
	if rate > 50000 {
		tones = append(tones, 23000, 23900)
	}
	var narrowL, narrowR float64
	for i := range left {
		at := float64(i) / rate
		sign := 1.0
		if i%2 == 1 {
			sign = -1
		}
		// One-pole low-passed noise mirrored to just below Nyquist.
		narrowL += 0.06 * (noise() - narrowL)
		narrowR += 0.06 * (noise() - narrowR)
		x := 0.3*math.Sin(2*math.Pi*55*at) + 0.2*math.Exp(-math.Mod(at, 0.25)*30)*math.Sin(2*math.Pi*70*at)
		clipped := math.Max(-0.12, math.Min(0.12, 0.3*math.Sin(2*math.Pi*3000*at)))
		var hf float64
		for k, f := range tones {
			gate := 0.0
			if int(at*8+float64(k))%3 != 0 {
				gate = 1
			}
			hf += 0.05 * gate * math.Sin(2*math.Pi*f*at+float64(k))
		}
		left[i] = x + clipped + hf + 0.6*sign*narrowL
		right[i] = 0.9*x - clipped + hf + 0.6*sign*narrowR
	}
	peak := 0.0
	for i := range left {
		peak = math.Max(peak, math.Max(math.Abs(left[i]), math.Abs(right[i])))
	}
	scale := math.Pow(10, -1.0/20) / peak
	outL, outR := make([]float32, frames), make([]float32, frames)
	for i := range left {
		outL[i], outR[i] = float32(left[i]*scale), float32(right[i]*scale)
	}
	return outL, outR
}

// ceilingChain returns the algorithm v2 export settings for a test chain:
// the heaviest live chain with Crisp or Tube saturation, or a bare limiter
// driven 12 dB into a fast 10 ms release, whose gain moves fastest.
func ceilingChain(chain string, ceiling float64) dsp.Params {
	var p dsp.Params
	switch chain {
	case "Crisp":
		p = heaviestLiveParams(dsp.TruePeakAlgorithmVersion, dsp.SatCrisp)
	case "Tube":
		p = heaviestLiveParams(dsp.TruePeakAlgorithmVersion, dsp.SatTube)
	default:
		p = dsp.DefaultParams()
		p.AlgorithmVersion, p.InputGainDB = dsp.TruePeakAlgorithmVersion, 12
		p.Limiter = dsp.LimiterParams{Enabled: true, TargetLUFS: -9, ReleaseMS: 10, TruePeak: true}
	}
	p.Limiter.CeilingDBTP = ceiling
	return p
}

// checkCeiling measures one export against the near-ideal reference: it must
// not exceed the ceiling, and neither the export meter (MeasureStereo, also
// behind Release Check) nor the live meter may under-read it by over 0.1 dB.
func checkCeiling(t *testing.T, left, right []float32, rate, ceiling float64, reported dsp.Metrics) {
	t.Helper()
	reference := truepeakref.PeakDBTP([][]float32{left, right}, 0)
	meter := dsp.NewLoudnessMeter(rate)
	meter.Process(left, right)
	live := meter.Snapshot().TruePeakDBTP
	t.Logf("reference %+.3f dBTP (ceiling %+.1f) | export meter %+.3f, live meter %+.3f", reference, ceiling, reported.TruePeakDBTP, live)
	if reference > ceiling {
		t.Errorf("reference true peak %.3f dBTP exceeds the %.1f dBTP ceiling", reference, ceiling)
	}
	for name, reading := range map[string]float64{"export": reported.TruePeakDBTP, "live": live} {
		if reading < reference-0.1 {
			t.Errorf("%s meter %.3f dBTP under-reads the reference %.3f dBTP by more than 0.1 dB", name, reading, reference)
		}
	}
}

// V1-13: every algorithm v2 export stays at or under its ceiling on a long-sinc
// (spectral, 32x) reconstruction, and the meters read it within 0.1 dB. The
// fixtures carry strong content up to 0.498 fs, which a 48-tap detector alone
// under-reads by up to 1.5 dB.
func TestExportsHoldTheCeilingAgainstTheLongSincReference(t *testing.T) {
	fixtures := map[string]func(float64, int) ([]float32, []float32){"dense": denseMix, "torture": nyquistTorture}
	type ceilingCase struct {
		fixture, chain string
		rate, ceiling  float64
	}
	var cases []ceilingCase
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, fixture := range []string{"dense", "torture"} {
			for _, chain := range []string{"Crisp", "Tube", "hot-limiter"} {
				cases = append(cases, ceilingCase{fixture, chain, rate, -1})
			}
			cases = append(cases, ceilingCase{fixture, "hot-limiter", rate, -2}, ceilingCase{fixture, "Crisp", rate, -1.5})
		}
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%s/%s/%.0f/%.1f", c.fixture, c.chain, c.rate, c.ceiling), func(t *testing.T) {
			t.Parallel()
			left, right := fixtures[c.fixture](c.rate, 2)
			outL, outR, metrics := dsp.RenderBuffer(left, right, c.rate, ceilingChain(c.chain, c.ceiling))
			checkCeiling(t, outL, outR, c.rate, c.ceiling, metrics)
		})
	}
}

// A converted export is limited again at the delivery rate after the
// resampler, then dithered: the delivered file must hold the ceiling too.
func TestConvertedExportsHoldTheCeilingAgainstTheLongSincReference(t *testing.T) {
	for _, c := range []struct{ from, to int }{{96000, 44100}, {44100, 48000}} {
		t.Run(fmt.Sprintf("%d-%d", c.from, c.to), func(t *testing.T) {
			t.Parallel()
			left, right := nyquistTorture(float64(c.from), 2)
			params := ceilingChain("hot-limiter", -1)
			options := mastering.ExportOptions{SampleRate: c.to}
			params.DitherBits = options.RenderDitherBits(c.from, 16, 0)
			outL, outR, rendered := dsp.RenderBuffer(left, right, float64(c.from), params)
			outL, outR, metrics, rate, err := mastering.ConvertExportContext(context.Background(), outL, outR, c.from, options.DitherBits(16, 0), params, rendered, options)
			if err != nil || rate != c.to {
				t.Fatalf("conversion failed: %v (rate %d)", err, rate)
			}
			checkCeiling(t, outL, outR, float64(rate), -1, metrics)
		})
	}
}
