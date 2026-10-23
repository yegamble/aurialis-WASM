package dsp

import (
	"math"
	"testing"
)

func TestStudioGainEnvelopeMatchesNaive(t *testing.T) {
	for _, cfg := range []struct{ delay, lookahead, hold int }{{0, 64, 0}, {0, 356, 0}, {0, 384, 0}, {0, 768, 0}, {0, 1536, 0}, {0, 384, 1026}, {513, 384, 0}} {
		var env studioGainEnvelope
		var plan [4096]float64
		for i := range plan {
			plan[i] = 1
		}
		seed := uint64(294031)
		difference := 0.0
		for frame := int64(0); frame < 50000; frame++ {
			seed = seed*6364136223846793005 + 1442695040888963407
			if frame < 42000 && frame%5 != 0 && (frame < 8000 || frame > 12000) {
				required := .001 + float64(seed>>11)/float64(uint64(1)<<53)*.998
				env.add(frame, cfg.delay, cfg.lookahead, cfg.hold, required)
				birth := frame + int64(cfg.delay)
				for u := birth; u <= birth+int64(cfg.lookahead+cfg.hold); u++ {
					weight := math.Min(1, float64(u-birth)/float64(cfg.lookahead))
					gain := 1 - (1-required)*weight
					i := int(u) & 4095
					plan[i] = math.Min(plan[i], gain)
				}
			}
			want := plan[int(frame)&4095]
			plan[int(frame)&4095] = 1
			got := env.bound(frame)
			difference = math.Max(difference, math.Abs(want-got))
			if math.Abs(want-got) > 2e-14 {
				t.Fatalf("cfg%v frame%d want%.17g got%.17g", cfg, frame, want, got)
			}
		}
		t.Logf("cfg%v max error%.3g", cfg, difference)
	}
}

func TestStudioLimiterGain4xEnvelopeMatchesNaive(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		params := studioLimiterGainTestParams()
		got, err := prepareStudioLimiterGain4x(rate, params)
		if err != nil {
			t.Fatal(err)
		}
		want, err := prepareStudioLimiterGain4xNaive(rate, params)
		if err != nil {
			t.Fatal(err)
		}
		maxError := 0.0
		for i := range 100000 {
			x := 2.1*math.Sin(float64(i)*.217) + .07*math.Cos(float64(i)*.493)
			if i > 12000 && i < 17000 {
				x = 0
			}
			if i == 23876 {
				x = 20
			}
			a, b, c, d := got.process(x, x*.7)
			w, z, e, f := want.process(x, x*.7)
			maxError = math.Max(maxError, math.Max(math.Abs(a-w), math.Abs(b-z)))
			if c != e || d != f || math.Abs(a-w) > 3e-13 || math.Abs(b-z) > 3e-13 || math.Abs(got.lastGain-want.lastGain) > 2e-13 {
				t.Fatalf("rate%.0f sample%d audio error%g gain error%g", rate, i, a-w, got.lastGain-want.lastGain)
			}
		}
		t.Logf("rate%.0f maxPCMerror%.3g", rate, maxError)
	}
}

func TestStudioGainEnvelopeLargeClockAndClippedRebuild(t *testing.T) {
	const start int64 = 9007199254740000
	const lookahead = 384
	const hold = 1026
	type event struct {
		birth    int64
		required float64
	}
	var events []event
	for i := range 48 {
		events = append(events, event{start + int64(i*37), .01 + float64((i*73)%97)/100})
	}
	var env studioGainEnvelope
	const now = start + 1073
	for _, v := range events {
		if v.birth <= now {
			env.addActive(now, v.birth, lookahead, hold, v.required)
		}
	}
	for frame := now; frame < now+3000; frame++ {
		for _, v := range events {
			if v.birth == frame && frame > now {
				env.addActive(frame, v.birth, lookahead, hold, v.required)
			}
		}
		want := 1.0
		for _, v := range events {
			if frame < v.birth || frame > v.birth+lookahead+hold {
				continue
			}
			weight := math.Min(1, float64(frame-v.birth)/lookahead)
			want = math.Min(want, 1-(1-v.required)*weight)
		}
		if got := env.bound(frame); math.Abs(got-want) > 3e-14 {
			t.Fatalf("clock%d got%.17g want%.17g", frame, got, want)
		}
	}
}
