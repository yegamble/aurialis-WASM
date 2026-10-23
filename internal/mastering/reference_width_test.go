package mastering

import (
	"context"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func widthReferenceFixture(sideAmplitude, sideFrequency float64) *audio.Buffer {
	return featureSignal(48000, 1, func(i int) (float32, float32) {
		mid := .2 + .05*math.Sin(2*math.Pi*997*float64(i)/48000)
		side := sideAmplitude * math.Sin(2*math.Pi*sideFrequency*float64(i)/48000)
		return float32(mid + side), float32(mid - side)
	})
}
func TestReferenceWidthIsOptInAndLevelIndependent(t *testing.T) {
	source, reference := widthReferenceFixture(.02, 3001), widthReferenceFixture(.04, 3001)
	baseline := dsp.DefaultParams()
	result, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1}, nil)
	if err != nil || result.Params.Stereo != baseline.Stereo || result.Width != nil {
		t.Fatal("width changed without opt-in", err)
	}
	result, err = MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1, IncludeWidth: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Width == nil || !result.Width.Applied || result.Params.Stereo.WidthPct != 120 || result.Width.AfterCorrelation < .1 || result.Width.AfterSideMidDB <= result.Width.BeforeSideMidDB {
		t.Fatalf("invalid conservative width: %+v", result.Width)
	}
	for i := range reference.Left {
		reference.Left[i] *= 2
		reference.Right[i] *= 2
	}
	scaled, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1, IncludeWidth: true}, nil)
	if err != nil || scaled.Params.Stereo.WidthPct != result.Params.Stereo.WidthPct {
		t.Fatal("level changed width proposal", err)
	}
	zero, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 0, IncludeWidth: true}, nil)
	if err != nil || zero.Params != baseline {
		t.Fatal("amount0 changed baseline", err)
	}
	clone := result.Clone()
	clone.Width.Reason = "mutated"
	if result.Width.Reason == "mutated" {
		t.Fatal("width snapshot aliases original")
	}
}
func TestReferenceWidthRespectsProtectedBassAndDisabledStereo(t *testing.T) {
	source, reference := widthReferenceFixture(.02, 60), widthReferenceFixture(.04, 60)
	baseline := dsp.DefaultParams()
	result, err := MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1, ProtectBelowHz: 120, IncludeWidth: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Width == nil || result.Params.Stereo.WidthPct <= 100 || result.Params.Stereo.WidthPct >= 120 || !result.ProtectionVerified || math.Abs(result.RemeasuredProtectedDeltaDB) > .25 {
		t.Fatalf("width bypassed bass guard: width%+v delta%g", result.Width, result.RemeasuredProtectedDeltaDB)
	}
	baseline.Stereo.Enabled = false
	result, err = MatchReferenceContext(context.Background(), source, reference, baseline, ReferenceOptions{Amount: 1, IncludeWidth: true}, nil)
	if err != nil || result.Params.Stereo != baseline.Stereo || result.Width == nil || result.Width.Applied {
		t.Fatal("disabled stereo changed", err)
	}
}
func TestReferenceWidthDoesNotInventStereoOrFollowNegativeCorrelation(t *testing.T) {
	mono := widthReferenceFixture(0, 3001)
	wide := widthReferenceFixture(.2, 3001)
	for _, pair := range [][2]*audio.Buffer{{mono, wide}, {widthReferenceFixture(.02, 3001), wide}} {
		result, err := MatchReferenceContext(context.Background(), pair[0], pair[1], dsp.DefaultParams(), ReferenceOptions{Amount: 1, IncludeWidth: true}, nil)
		if err != nil || result.Width == nil || result.Width.Applied || result.Params.Stereo.WidthPct != 100 {
			t.Fatal("unsafe or fabricated width proposal", err)
		}
	}
}
