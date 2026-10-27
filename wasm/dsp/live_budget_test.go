package main

import (
	"fmt"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// heaviestLiveParams turns on every module the UI can enable together: five
// boosted EQ bands, de-harsh, three-band multiband, the compressor, the
// heaviest saturation model, M/S width with mono bass and the limiter. Repair
// is excluded because the UI cannot enable it (engineParams rejects it).
func heaviestLiveParams(algorithm uint32, character dsp.SatCharacter) dsp.Params {
	p := dsp.DefaultParams()
	p.AlgorithmVersion = algorithm
	p.InputGainDB = 6
	for i := range p.Bands {
		p.Bands[i].GainDB = 2
	}
	p.DeHarsh = dsp.DeHarshParams{Enabled: true, FrequencyHz: 5000, ThresholdDB: -30, RangeDB: 6}
	p.Multiband = dsp.MultibandParams{Enabled: true, LowMidHz: 200, MidHighHz: 3000}
	for i := range p.Multiband.Bands {
		p.Multiband.Bands[i] = dsp.DynamicsBandParams{ThresholdDB: -24, Ratio: 3, AttackMS: 10, ReleaseMS: 120, MakeupDB: 1}
	}
	p.Compressor.ThresholdDB, p.Compressor.Ratio, p.Compressor.AutoRelease = -20, 3, true
	p.Saturation.Amount, p.Saturation.Character = 60, character
	p.Stereo = dsp.StereoParams{Enabled: true, WidthPct: 130, MonoBass: true, CrossoverHz: 110, MidGainDB: 1, SideGainDB: -1}
	p.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -9, ReleaseMS: 80, TruePeak: algorithm == dsp.TruePeakAlgorithmVersion}
	return p
}

// BenchmarkLiveBlock measures one 128-frame live quantum through the shared
// block bridge (validation, engine, loudness meter), as the worklet calls it.
// ns/op divided by the quantum's real-time duration is the CPU load factor.
func BenchmarkLiveBlock(b *testing.B) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, algorithm := range []uint32{dsp.LegacyAlgorithmVersion, dsp.TruePeakAlgorithmVersion} {
			for _, character := range []dsp.SatCharacter{dsp.SatWarm, dsp.SatTube, dsp.SatTransformer} {
				name := fmt.Sprintf("rate=%.0f/algorithm=%d/saturation=%s", rate, algorithm, character)
				b.Run(name, func(b *testing.B) {
					blocks := liveBlockBridge{bridge: NewBridge(rate)}
					if !blocks.bridge.SetParams(heaviestLiveParams(algorithm, character)) {
						b.Fatal("heaviest params rejected")
					}
					left, right := denseMix(rate, 1)
					b.ReportAllocs()
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						start := (i * liveBlockFrames) % (len(left) - liveBlockFrames)
						copy(blocks.channels[0][:], left[start:])
						copy(blocks.channels[1][:], right[start:])
						if blocks.process() != liveBlockFrames {
							b.Fatal("block rejected")
						}
					}
					b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/(liveBlockFrames/rate*1e9), "load")
				})
			}
		}
	}
}
