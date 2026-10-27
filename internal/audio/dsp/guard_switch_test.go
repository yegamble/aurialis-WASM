package dsp

import (
	"fmt"
	"math"
	"testing"
)

// highPass16k is a 4th-order Butterworth high-pass at 16 kHz (two RBJ
// sections) that isolates the splice energy a guard switch leaves behind.
type highPass16k struct{ sections [2]meterBiquad }

func newHighPass16k(rate float64) highPass16k {
	var h highPass16k
	for i, q := range []float64{0.5411961, 1.3065630} {
		w := 2 * math.Pi * 16000 / rate
		alpha := math.Sin(w) / (2 * q)
		a0 := 1 + alpha
		c := math.Cos(w)
		h.sections[i] = meterBiquad{b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0}
	}
	return h
}

func (h *highPass16k) sample(x float64) float64 {
	for i := range h.sections {
		x = h.sections[i].sample(x, 0)
	}
	return x
}

// V1-13 Round E S1: switching the limiter or its true-peak mode live, at
// unity gain reduction, crossfades guarded and unguarded audio over about
// 5 ms, so the switch leaves no splice above 16 kHz. Leaving bypass restarts
// the guard from silence and fades it in rather than splicing in a filter
// state built from other audio.
func TestGuardSwitchLeavesNoSplice(t *testing.T) {
	for _, rate := range []float64{44100, 48000} {
		for _, toggle := range []string{"limiter", "truePeak", "bypass"} {
			t.Run(fmt.Sprintf("%.0f/%s", rate, toggle), func(t *testing.T) {
				on := DefaultParams()
				on.AlgorithmVersion = TruePeakAlgorithmVersion
				on.Limiter = LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 80, TruePeak: true}
				off := on
				switch toggle {
				case "limiter":
					off.Limiter.Enabled = false
				case "truePeak":
					off.Limiter.TruePeak = false
				default:
					off.Bypass = true
				}
				e := NewEngine(rate)
				e.SetParams(on)
				const block = 128
				blocks := int(rate*0.6) / block
				in := [2][]float32{make([]float32, block), make([]float32, block)}
				out := [2][]float32{make([]float32, block), make([]float32, block)}
				hp := newHighPass16k(rate)
				var steady, splice float64
				frame := 0
				for b := 0; b < blocks; b++ {
					switch b {
					case blocks / 3:
						e.SetParams(off)
					case 2 * blocks / 3:
						e.SetParams(on)
					}
					for i := range block {
						at := float64(frame+i) / rate
						// Unity gain reduction: peaks near -9 dBFS.
						x := 0.2*math.Sin(2*math.Pi*1000*at) + 0.15*math.Sin(2*math.Pi*6000*at+0.4)
						in[0][i], in[1][i] = float32(x), float32(0.8*x)
					}
					e.ProcessBlock(in[0], in[1], out[0], out[1])
					for i := range block {
						y := math.Abs(hp.sample(float64(out[0][i])))
						switch at := frame + i; {
						case at > int(rate*0.1) && at < blocks/3*block:
							steady = math.Max(steady, y)
						case at >= blocks/3*block:
							splice = math.Max(splice, y)
						}
					}
					frame += block
				}
				if e.LastGainReductionDB() > 0.01 {
					t.Fatalf("not at unity gain: %.3f dB", e.LastGainReductionDB())
				}
				t.Logf("above 16 kHz: steady %.2e, around the switches %.2e", steady, splice)
				// The 6 kHz tone leaks through the high-pass; a switch may add no more
				// than 0.0006 (-64 dBFS) to that. An instant switch added 0.0025-0.011.
				if splice > steady+0.0006 {
					t.Fatalf("switch left %.4f above 16 kHz against %.4f steady", splice, steady)
				}
			})
		}
	}
}
