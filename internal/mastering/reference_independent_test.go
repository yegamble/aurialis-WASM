package mastering

import (
	"context"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"math"
	"testing"
)

func TestIndependentNarrowOverlapBoostGuard(t *testing.T) {
	p := dsp.DefaultParams()
	for i := range p.Bands {
		p.Bands[i].Enabled = false
	}
	for i := range 2 {
		p.Bands[i] = dsp.BandParams{FreqHz: 1000, GainDB: 20, Q: 20, Type: dsp.FilterPeaking, Enabled: true}
	}
	r := &ReferenceProposal{Baseline: p, Params: p}
	for i := range 5 {
		r.Bands[i] = ReferenceBand{LowHz: spectrumEdges[i], HighHz: spectrumEdges[i+1], Included: true}
	}
	r.Bands[2].TargetDeltaDB = 6
	fit, err := fitReferenceContext(context.Background(), r, 48000)
	if err != nil {
		t.Fatal(err)
	}
	coarse, _ := referenceResponseBounds(r, fit, 48000, 41)
	fine, _ := referenceResponseBounds(r, fit, 48000, 401)
	actual := referenceResponseDelta(r, fit, 48000, 1000)
	t.Logf("knob delta %g/%g; guard41 %g guard401 %g exact-center %g; residual %g->%g", fit.Bands[0].GainDB-20, fit.Bands[1].GainDB-20, coarse, fine, actual, referenceResidual(r, p, 48000), referenceResidual(r, fit, 48000))
	if actual > 3+.0001 && math.Max(coarse, fine) <= 3 {
		t.Fatalf("narrow overlapping filters bypassed total-response cap: %g dB actual peak", actual)
	}
}

// A separate dense sweep challenges high-Q shelves, gain-dependent pole movement,
// overlapping peaks and Nyquist clamping; it is not the optimizer's probe grid.
func TestIndependentResponseExtremaAgainstDenseSweep(t *testing.T) {
	for _, rate := range []float64{8000, 48000, 192000} {
		for _, kind := range []dsp.FilterType{dsp.FilterPeaking, dsp.FilterLowShelf, dsp.FilterHighShelf} {
			for _, frequency := range []float64{63, 1000, rate * .48} {
				baseline := dsp.DefaultParams()
				for i := range baseline.Bands {
					baseline.Bands[i].Enabled = false
				}
				for i := range 2 {
					baseline.Bands[i] = dsp.BandParams{FreqHz: frequency + float64(i)*frequency*.003, GainDB: 20, Q: 20, Type: kind, Enabled: true}
				}
				candidate := baseline
				candidate.Bands[0].GainDB = 22.75
				candidate.Bands[1].GainDB = 22.875
				proposal := &ReferenceProposal{Baseline: baseline, Options: ReferenceOptions{ProtectBelowHz: 120}}
				boost, protected := referenceResponseBounds(proposal, candidate, rate, 41)
				actualBoost, actualProtected := 0.0, 0.0
				for index := range 10001 {
					f := 20 * math.Pow(math.Min(20000, rate*.499)/20, float64(index)/10000)
					actualBoost = math.Max(actualBoost, referenceResponseDelta(proposal, candidate, rate, f))
					f = 20 + 100*float64(index)/10000
					actualProtected = math.Max(actualProtected, math.Abs(referenceResponseDelta(proposal, candidate, rate, f)))
				}
				if actualBoost > boost+.0001 || actualProtected > protected+.0001 {
					t.Fatalf("rate%g %s freq%g: boost%g actual%g protected%g actual%g", rate, kind, frequency, boost, actualBoost, protected, actualProtected)
				}
			}
		}
	}
}
