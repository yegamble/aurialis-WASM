package dsp

import (
	"fmt"
	"math"
	"testing"
)

func TestStudioGraphEveryModuleChangesItsIntendedAudio(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		left, right := studioGraphSignal(2048)
		for i := range left {
			left[i] *= 2
			right[i] *= 2
		}
		for module := range 9 {
			p := studioGraphNeutralParams()
			switch module {
			case 0:
				p.EQEnabled = true
				p.Bands[2].GainDB = 6
			case 1:
				p.Repair = RepairParams{Enabled: true, DeClip: true, DeEssDB: 6, TransientDB: 4}
			case 2:
				p.DeHarsh = DeHarshParams{Enabled: true, FrequencyHz: 3000, ThresholdDB: -45, RangeDB: 6}
			case 3:
				p.Multiband = MultibandParams{Enabled: true, LowMidHz: 200, MidHighHz: 3000}
				for i := range p.Multiband.Bands {
					p.Multiband.Bands[i] = DynamicsBandParams{ThresholdDB: -30, Ratio: 4, AttackMS: 5, ReleaseMS: 100}
				}
			case 4:
				p.Compressor.Enabled = true
				p.Compressor.KneeDB = 12
				p.Compressor.Ratio = 3
				p.Compressor.ThresholdDB = -18
			case 5:
				p.Saturation = SaturationParams{Enabled: true, Amount: 35, Character: SatTransformer}
			case 6:
				p.Stereo.Enabled = true
				p.Stereo.WidthPct = 130
				p.Stereo.MonoBass = true
			case 7:
				p.Limiter.Enabled = true
			case 8:
				p.DitherBits = 16
			}
			g := mustStudioGraph(t, rate, p, len(left), false)
			a, b := renderStudioGraph(t, g, left, right, 129)
			energy := 0.0
			for i := range left {
				dl, dr := float64(a[g.latency+i]-left[i]), float64(b[g.latency+i]-right[i])
				energy += dl*dl + dr*dr
			}
			difference := math.Sqrt(energy / float64(2*len(left)))
			if difference < 1e-7 {
				t.Fatalf("rate%g module%d had no measurable output effect: %g", rate, module, difference)
			}
		}
	}
}

func TestStudioGraphLimiterModesRetainQuietAudioAndRequireRealReduction(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, truePeak := range []bool{false, true} {
			p := studioGraphNeutralParams()
			p.Limiter.Enabled = true
			p.Limiter.TruePeak = truePeak
			g := mustStudioGraph(t, rate, p, 4096, false)
			left, right := make([]float32, 4096), make([]float32, 4096)
			for i := range left {
				left[i] = float32(.01 * math.Sin(2*math.Pi*.173*float64(i)))
				right[i] = left[i]
			}
			a, _ := renderStudioGraph(t, g, left, right, 127)
			before, after := 0.0, 0.0
			for i := 512; i < len(left)-512; i++ {
				before += float64(left[i]) * float64(left[i])
				after += float64(a[g.latency+i]) * float64(a[g.latency+i])
			}
			delta := 10 * math.Log10(after/before)
			if math.Abs(delta) > .01 || g.gain.lastGain != 1 || g.guard.lastGain != 1 {
				t.Fatalf("rate%g truePeak%v quiet signal changed by %g dB or invoked reduction", rate, truePeak, delta)
			}
			if err := g.resetAt(0); err != nil {
				t.Fatal(err)
			}
			for i := range left {
				left[i] = float32(1.8 * math.Sin(2*math.Pi*.173*float64(i)))
				right[i] = left[i]
			}
			a, _ = renderStudioGraph(t, g, left, right, 129)
			peak := 0.0
			for _, x := range a[g.latency:] {
				peak = math.Max(peak, math.Abs(float64(x)))
			}
			if peak > dbToLin(p.Limiter.CeilingDBTP)+1e-6 || peak < .5 {
				t.Fatalf("rate%g truePeak%v hot output peak%g violated sample ceiling or was silenced", rate, truePeak, peak)
			}
		}
	}
}

var studioGraphBenchmarkSink float32

func BenchmarkStudioGraphAllActive(b *testing.B) {
	for _, rate := range []float64{48000, 96000, 192000} {
		for _, makeup := range []float64{2, 12} {
			b.Run(fmt.Sprintf("rate%.0f/makeup%.0f", rate, makeup), func(b *testing.B) {
				p := studioGraphActiveParams()
				p.DitherBits = 24
				p.Compressor.MakeupDB = makeup
				g := mustStudioGraph(b, rate, p, 128, true)
				left, right := studioGraphSignal(128)
				for i := range left {
					left[i] *= 4
					right[i] *= 4
				}
				var a, c [128]float32
				process := func() {
					if g.processBlock(left, right, a[:], c[:]) != 128 {
						b.Fatal("private graph stopped")
					}
					studioGraphBenchmarkSink = a[127] + c[127]
				}
				for range 64 {
					process()
				}
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					process()
				}
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*128), "ns/frame")
			})
		}
	}
}

func TestStudioGraphActualLevelsUseOnlyExplicitGains(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, original := range []bool{false, true} {
			p := studioGraphNeutralParams()
			p.InputGainDB = 6
			p.ABOriginal = original
			left, right := studioGraphSignal(2048)
			g := mustStudioGraph(t, rate, p, len(left), false)
			a, b := renderStudioGraph(t, g, left, right, 129)
			gain := dbToLin(6)
			if original {
				gain = 1
			}
			before, after := 0.0, 0.0
			for i := range left {
				expectedL, expectedR := float32(float64(left[i])*gain), float32(float64(right[i])*gain)
				if math.Float32bits(a[g.latency+i]) != math.Float32bits(expectedL) || math.Float32bits(b[g.latency+i]) != math.Float32bits(expectedR) {
					t.Fatal("graph changed actual levels beyond the explicit gain or altered Original")
				}
				before += float64(left[i]) * float64(left[i])
				after += float64(a[g.latency+i]) * float64(a[g.latency+i])
			}
			expectedDB := 6.0
			if original {
				expectedDB = 0
			}
			if delta := 10 * math.Log10(after/before); math.Abs(delta-expectedDB) > 1e-6 {
				t.Fatalf("actual A/B level changed: %g want%g", delta, expectedDB)
			}
		}
	}
}
