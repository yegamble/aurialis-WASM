package dsp

import (
	"math"
	"testing"
)

// These pin the engine behavior that src/lib/control-conventions.ts reports in
// pro-plugin terms: shelf midpoints, gain-dependent bell Q, the mono-bass -3 dB
// point and the 91.8% compressor time definition.

func sineGainDB(t *testing.T, p Params, freq, rate float64, sideOnly bool) float64 {
	t.Helper()
	e := NewEngine(rate)
	e.SetParams(p)
	n := int(rate)
	inL, inR := make([]float32, n), make([]float32, n)
	for i := range inL {
		v := float32(0.1 * math.Sin(2*math.Pi*freq*float64(i)/rate))
		inL[i], inR[i] = v, v
		if sideOnly {
			inR[i] = -v
		}
	}
	outL, outR := make([]float32, n), make([]float32, n)
	e.ProcessBlock(inL, inR, outL, outR)
	var in, out float64
	for i := n / 2; i < n; i++ {
		in += float64(inL[i]) * float64(inL[i])
		d := float64(outL[i])
		if sideOnly {
			d = 0.5 * float64(outL[i]-outR[i])
		}
		out += d * d
	}
	return 10 * math.Log10(out/in)
}

func TestShelfMidpointMatchesReportedConvention(t *testing.T) {
	for _, tc := range []struct {
		typ   FilterType
		label float64
		mid   float64
	}{{FilterLowShelf, 100, 185}, {FilterLowShelf, 250, 462.5}, {FilterHighShelf, 8000, 8000 / 1.54}} {
		p := DefaultParams()
		p.Bands[0] = BandParams{FreqHz: tc.label, GainDB: 6, Q: 0.707, Type: tc.typ, Enabled: true}
		p.Bands[4].Enabled = false
		if got := sineGainDB(t, p, tc.mid, 48000, false); math.Abs(got-3) > 0.15 {
			t.Fatalf("%s %g Hz: gain at reported midpoint %.1f Hz = %.2f dB, want +3", tc.typ, tc.label, tc.mid, got)
		}
	}
}

func TestBellEffectiveQMatchesReportedConvention(t *testing.T) {
	p := DefaultParams()
	p.Bands[2] = BandParams{FreqHz: 1000, GainDB: 6, Q: 1, Type: FilterPeaking, Enabled: true}
	q := 1 * (1 + 0.25*6)
	// Half-gain points of a bell with quality q sit at f0·(sqrt(1+1/(4q²)) ± 1/(2q)).
	root := math.Sqrt(1 + 1/(4*q*q))
	for _, f := range []float64{1000 * (root - 1/(2*q)), 1000 * (root + 1/(2*q))} {
		if got := sineGainDB(t, p, f, 48000, false); math.Abs(got-3) > 0.25 {
			t.Fatalf("gain at %.1f Hz = %.2f dB, want +3 for effective Q %.2f", f, got, q)
		}
	}
}

func TestMonoBassMinus3dBMatchesReportedConvention(t *testing.T) {
	p := DefaultParams()
	p.Stereo = StereoParams{Enabled: true, WidthPct: 100, MonoBass: true, CrossoverHz: 110}
	f := 110 * 1.45 * math.Pow(math.Pow(0.5, -0.25)-1, -0.25)
	if got := sineGainDB(t, p, f, 48000, true); math.Abs(got+3) > 0.1 {
		t.Fatalf("side gain at %.1f Hz = %.2f dB, want -3", f, got)
	}
}
