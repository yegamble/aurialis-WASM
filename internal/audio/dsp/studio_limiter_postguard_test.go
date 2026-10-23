package dsp

import (
	"math"
	"testing"
)

// The scalar scan uses the original peak-index formulation, independent of the
// cached timed-line envelope. It includes negative startup indices and both modes.
func studioPostGuardScalarBound(g *studioPostGuardLimiter, source int64) float64 {
	support := 0
	if g.params.TruePeak {
		support = studioPostGuardAvailability
	}
	bound := 1.0
	for frame := source - int64(support); frame <= source+int64(g.lookahead+support); frame++ {
		peak := g.peaks[frame&(studioPostGuardLimiterCapacity-1)]
		if peak.frame != frame || peak.required >= 1 {
			continue
		}
		distance := frame - source - int64(support)
		weight := 1.0
		if distance > 0 {
			weight = 1 - float64(distance)/float64(g.lookahead)
		}
		bound = math.Min(bound, 1-(1-peak.required)*weight)
	}
	return bound
}

func TestStudioPostGuardEnvelopePreservesBothModesAndControlHistory(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioLimiterGainTestParams()
		g, err := prepareStudioPostGuardLimiter(rate, p)
		if err != nil {
			t.Fatal(err)
		}
		for i := range 15000 {
			changed := false
			switch i {
			case 2100:
				p.CeilingDBTP = -4
				changed = true
			case 4300:
				p.TruePeak = false
				changed = true
			case 6700:
				p.Enabled = false
				changed = true
			case 7800:
				p.Enabled = true
				changed = true
			case 9900:
				p.TruePeak = true
				changed = true
			case 12300:
				p.CeilingDBTP = -1
				changed = true
			}
			if changed {
				if err := g.setParams(p); err != nil {
					t.Fatal(err)
				}
			}
			x := 2.1*math.Sin(float64(i)*2*math.Pi*.49) + .07*math.Cos(float64(i)*.493)
			if i > 13000 {
				x = 0
			}
			a, b := g.process(x, x*.7)
			clock := g.frame - 1
			want := studioPostGuardScalarBound(&g, clock-int64(g.latency))
			got := g.envelope.bound(clock)
			if math.Abs(got-want) > 2e-14 {
				t.Fatalf("rate%g frame%d planned gain %g want %g", rate, i, got, want)
			}
			if !finite(a) || !finite(b) || math.Abs(b-.7*a) > 1e-12 {
				t.Fatal("post guard lost finite stereo linkage")
			}
		}
	}
}

func TestStudioPostGuardDisabledDelayResetAndAllocation(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioLimiterGainTestParams()
		p.Enabled = false
		g, err := prepareStudioPostGuardLimiter(rate, p)
		if err != nil {
			t.Fatal(err)
		}
		input := []float64{1, -.7, 1e-40, math.Copysign(0, -1)}
		for i := 0; i < len(input)+g.latency; i++ {
			x := 0.0
			if i < len(input) {
				x = input[i]
			}
			a, b := g.process(x, x)
			want := 0.0
			if i >= g.latency {
				want = input[i-g.latency]
			}
			if math.Float64bits(a) != math.Float64bits(want) || math.Float64bits(b) != math.Float64bits(want) {
				t.Fatalf("rate%g frame%d disabled post guard changed delayed input", rate, i)
			}
		}
		g.resetHistory()
		for range g.latency + 1 {
			a, b := g.process(0, 0)
			if a != 0 || b != 0 {
				t.Fatal("post guard reset retained audio")
			}
		}
		if n := testing.AllocsPerRun(1000, func() { g.process(.4, -.3) }); n != 0 {
			t.Fatalf("post guard allocated %g times", n)
		}
	}
}
