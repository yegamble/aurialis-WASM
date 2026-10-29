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

// Reset modules and bypass must not release the delayed, boosted input at
// unity gain. Only newly queued neutral audio is unprotected; once the guard
// fades out it must equal the delayed source bit for bit.
func TestLimitedToNeutralRetainsQueuedGain(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, bypass := range []bool{false, true} {
			for _, inputGain := range []float64{6, 12} {
				t.Run(fmt.Sprintf("%.0f/bypass=%t/gain=%.0f", rate, bypass, inputGain), func(t *testing.T) {
					p := truePeakParams(-1)
					p.InputGainDB = inputGain
					e := NewEngine(rate)
					e.SetParams(p)
					const block, warmup, captured = 128, 400, 8
					in, out := [2][block]float32{}, [2][block]float32{}
					source := make([]float32, (warmup+captured)*block)
					for i := range source {
						source[i] = float32(dbToLin(-3.1) * math.Sin(2*math.Pi*220*float64(i)/rate))
					}
					var peak float64
					identityStart := e.LatencyFrames() + int(math.Ceil(rate*guardFadeSeconds))
					for b := range warmup + captured {
						if b == warmup {
							if gr := e.LastGainReductionDB(); gr < 3 {
								t.Fatalf("fixture needs gain reduction: %.3f dB", gr)
							}
							off := DefaultParams()
							off.AlgorithmVersion = TruePeakAlgorithmVersion
							if bypass {
								off = p
								off.Bypass = true
							}
							e.SetParams(off)
						}
						for i := range block {
							in[0][i], in[1][i] = source[b*block+i], -0.8*source[b*block+i]
						}
						e.ProcessBlock(in[0][:], in[1][:], out[0][:], out[1][:])
						if b < warmup {
							continue
						}
						for i := range block {
							peak = math.Max(peak, math.Max(math.Abs(float64(out[0][i])), math.Abs(float64(out[1][i]))))
							if (b-warmup)*block+i >= identityStart {
								want := source[b*block+i-e.LatencyFrames()]
								if out[0][i] != want || out[1][i] != -0.8*want {
									t.Fatalf("steady neutral changed source at frame %d", b*block+i)
								}
							}
						}
					}
					t.Logf("transition peak %.3f dBFS", linToDB(peak))
					if peak > dbToLin(-1) || math.IsNaN(peak) {
						t.Fatalf("transition released queued audio over the ceiling: %.3f dBFS", linToDB(peak))
					}
				})
			}
		}
	}
}

func TestQueuedGainSurvivesInterruptedGuardFade(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, mode := range []string{"limiter-off", "true-peak-off", "rapid-neutral", "rapid-bypass"} {
			t.Run(fmt.Sprintf("%.0f/%s", rate, mode), func(t *testing.T) {
				on := truePeakParams(-1)
				on.InputGainDB = 12
				off := on
				switch mode {
				case "limiter-off":
					off.Limiter.Enabled = false
				case "true-peak-off":
					off.Limiter.TruePeak = false
				case "rapid-neutral":
					off = DefaultParams()
					off.AlgorithmVersion = TruePeakAlgorithmVersion
				default:
					off.Bypass = true
				}
				e := NewEngine(rate)
				e.SetParams(on)
				var in, out [2][128]float32
				frame := 0
				process := func(n int) {
					for i := range n {
						x := float32(dbToLin(-3.1) * math.Sin(2*math.Pi*220*float64(frame+i)/rate))
						in[0][i], in[1][i] = x, -0.8*x
					}
					e.ProcessBlock(in[0][:n], in[1][:n], out[0][:n], out[1][:n])
					frame += n
				}
				for range 400 {
					process(128)
				}
				e.SetParams(off)
				settled := e.LatencyFrames() + int(math.Ceil(rate*guardFadeSeconds))
				var unprotectedPeak float64
				for at := 0; at < settled+512; at += 13 {
					if mode == "rapid-neutral" || mode == "rapid-bypass" {
						if at%26 == 0 {
							e.SetParams(off)
						} else {
							e.SetParams(on)
						}
					}
					process(13)
					for i := range 13 {
						peak := math.Max(math.Abs(float64(out[0][i])), math.Abs(float64(out[1][i])))
						if math.IsNaN(peak) || math.IsInf(peak, 0) {
							t.Fatal("non-finite transition output")
						}
						if (mode != "limiter-off" || at+i < e.LatencyFrames()) && peak > dbToLin(-1)+1e-7 {
							t.Fatalf("unprotected transition frame %d: %.3f dBFS", at+i, linToDB(peak))
						}
						if at+i >= settled {
							unprotectedPeak = math.Max(unprotectedPeak, peak)
						}
					}
				}
				if mode == "limiter-off" && unprotectedPeak <= 1 {
					t.Fatal("disabling the limiter still limits newly unprotected boosted audio")
				}
			})
		}
	}
}
