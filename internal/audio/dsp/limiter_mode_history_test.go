package dsp

import "testing"

func TestReturningToSampleLimitingCannotReplayItsOldEnvelope(t *testing.T) {
	p := DefaultParams()
	p.AlgorithmVersion = TruePeakAlgorithmVersion
	p.Limiter.Enabled, p.Limiter.TruePeak = true, false
	p.Limiter.ReleaseMS = 10
	old, fresh := NewEngine(48000), NewEngine(48000)
	old.SetParams(p)
	var hot, quiet, outL, outR [128]float32
	for i := range hot {
		hot[i], quiet[i] = 2, .01
	}
	for range 100 {
		old.ProcessBlock(hot[:], hot[:], outL[:], outR[:])
	}
	p.Limiter.TruePeak = true
	old.SetParams(p)
	fresh.SetParams(p)
	for range 100 {
		old.ProcessBlock(quiet[:], quiet[:], outL[:], outR[:])
		fresh.ProcessBlock(quiet[:], quiet[:], outL[:], outR[:])
	}
	p.Limiter.TruePeak = false
	old.SetParams(p)
	fresh.SetParams(p)
	var wantL, wantR [128]float32
	old.ProcessBlock(quiet[:], quiet[:], outL[:], outR[:])
	fresh.ProcessBlock(quiet[:], quiet[:], wantL[:], wantR[:])
	for i := range outL {
		if outL[i] != wantL[i] || outR[i] != wantR[i] {
			t.Fatalf("sample %d retained an inactive envelope: %g != %g", i, outL[i], wantL[i])
		}
	}
}
