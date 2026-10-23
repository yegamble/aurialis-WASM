package dsp

import (
	"math"
	"testing"
)

func TestStudioTransformerBoundedContributionAndLinearComplement(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		coeffs, state := prepareStudioTransformer(rate, 100), studioTransformerState{}
		prior := 0.0
		for frame := range 1024 {
			x := 1e-5 * math.Sin(float64(frame)*.3)
			y := state.process(x, coeffs)
			if math.Abs(y-.5*(x+prior)) > 1e-9 {
				t.Fatal("Transformer duplicated/attenuated the small-signal linear path")
			}
			prior = x
		}
		for _, x := range []float64{0, .1, 1, -1, 1e8, -1e8, math.MaxFloat32} {
			y := state.process(x, coeffs)
			if !finite(y) || math.Abs(y-.5*(x+prior)) > .4*(1+1/coeffs.curve.drive)+1e-9 {
				t.Fatal("Transformer nonlinear contribution exceeded its global bound")
			}
			prior = x
		}
	}
}

func TestStudioTransformerFluxUsesPhysicalLeakyIntegration(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		coeffs, state := prepareStudioTransformer(rate, 100), studioTransformerState{}
		for range int(rate * studioOversampling * .05) {
			state.process(1, coeffs)
		}
		initial := state.flux
		frames := int(math.Round(rate * studioOversampling / (2 * math.Pi * 35)))
		for range frames {
			state.process(0, coeffs)
		}
		want := math.Exp(-2 * math.Pi * 35 * float64(frames) / (rate * studioOversampling))
		if math.Abs(state.flux/initial-want) > 1e-10 {
			t.Fatal("flux memory used a sample-rate-dependent physical cutoff")
		}
		low := studioSaturationToneGain(t, rate, 40, .7, SatTransformer)
		high := studioSaturationToneGain(t, rate, 1000, .7, SatTransformer)
		if low > high-.2 {
			t.Fatalf("rate %g Transformer low-frequency nonlinear response %g versus HF %g dB", rate, low, high)
		}
	}
}

func TestStudioTransformerDelayedNullDCFiniteResetAndUpdates(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		s := mustStudioSaturation(t, rate, 0, SatTransformer)
		for frame := range 512 {
			input := 0.0
			if frame == 0 {
				input = 1
			}
			l, r := s.process(input, input)
			want := 0.0
			if frame == studioSaturationLatency {
				want = 1
			}
			if l != want || r != want {
				t.Fatal("Transformer no-drive delay is not exact")
			}
		}
		p := s.params
		p.Amount = 100
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		last := 0.0
		for range int(rate) {
			last, _ = s.process(1, 1)
		}
		if math.Abs(last) > math.Pow(10, -90.0/20) {
			t.Fatal("Transformer DC did not settle below -90 dBFS")
		}
		for _, amount := range []float64{25, 100, 0} {
			p.Amount = amount
			if err := s.setParams(p); err != nil {
				t.Fatal(err)
			}
			for frame := range 1000 {
				x := .2 + .01*math.Sin(float64(frame)*.63)
				l, r := s.process(x, x*.5)
				if !finite(l) || !finite(r) || math.Abs(l) > 2 || math.Abs(r) > 2 {
					t.Fatal("Transformer drive edit emitted an antiderivative spike")
				}
			}
		}
		p.Amount = 100
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		s.resetHistory()
		for _, input := range []float64{math.MaxFloat32, math.NaN(), math.Inf(1), 0} {
			s.process(input, -input)
			for range 512 {
				l, r := s.process(0, 0)
				if !finite(l) || !finite(r) {
					t.Fatal("Transformer emitted a nonfinite overload")
				}
			}
		}
		s.resetHistory()
		if s.transformer != ([2]studioTransformerState{}) {
			t.Fatal("Transformer reset retained flux/ADAA memory")
		}
		for range 512 {
			if l, r := s.process(0, 0); l != 0 || r != 0 {
				t.Fatal("Transformer reset replayed old audio")
			}
		}
	}
	s := mustStudioSaturation(t, 48000, 25, SatTransformer)
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			s.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("Transformer processing allocated")
	}
}

func TestStudioTransformerNominalAliasAndPublishedHotDriveWorstCase(t *testing.T) {
	nominalWorst, hotWorst := -1000.0, -1000.0
	for _, rate := range []float64{44100, 48000} {
		for _, bin := range []int{997, 2011, 3451} {
			alias, fundamental := studioSaturationAlias(t, rate, 25, .25, SatTransformer, bin)
			nominalWorst = math.Max(nominalWorst, alias)
			if alias > -75 || fundamental < -15 {
				t.Fatalf("Transformer nominal rate %g bin %d alias %g fundamental %g", rate, bin, alias, fundamental)
			}
			alias, fundamental = studioSaturationAlias(t, rate, 100, 1, SatTransformer, bin)
			hotWorst = math.Max(hotWorst, alias)
			if !finite(alias) || !finite(fundamental) || fundamental < -20 {
				t.Fatal("Transformer hot fixture silent/nonfinite")
			}
		}
	}
	t.Logf("Transformer coherent nominal amount25/peak.25 unwanted foldback worst %g dBFS; hot amount100/peak1 worst %g dBFS", nominalWorst, hotWorst)
}
