package dsp

import (
	"math"
	"testing"
)

// The statistics observe every processed sample, so the average compressor
// reduction of a steady tone equals its static transfer curve and the limiter
// peak equals the reduction a known overshoot needs.
func TestGainReductionStatsMeasureEverySample(t *testing.T) {
	const rate = 48000
	tone := func(peak float64, frames int) ([]float32, []float32) {
		left, right := make([]float32, frames), make([]float32, frames)
		for i := range left {
			value := float32(peak * math.Sin(2*math.Pi*1000*float64(i)/rate))
			left[i], right[i] = value, value
		}
		return left, right
	}
	p := DefaultParams()
	p.Saturation.Enabled = false
	p.Compressor = CompressorParams{Enabled: true, ThresholdDB: -20, Ratio: 4, AttackMS: 5, ReleaseMS: 100, KneeDB: 0, SidechainHPFHz: 0, Topology: CompFET}
	e := NewEngine(rate)
	e.SetParams(p)
	// 2 s of a -6 dBFS tone: FET peak sensing reads -6 dB, 14 dB over a 4:1 threshold.
	left, right := tone(dbToLin(-6), 2*rate)
	outL, outR := make([]float32, len(left)), make([]float32, len(left))
	for start := 0; start < len(left); start += 128 {
		e.ProcessBlock(left[start:start+128], right[start:start+128], outL[start:start+128], outR[start:start+128])
	}
	stats := e.GainReductionStats()
	if stats.CompressorFrames < int64(len(left))-rate/100 {
		t.Fatalf("audible frames %d of %d", stats.CompressorFrames, len(left))
	}
	if want := 14 * (1 - 1.0/4); math.Abs(stats.CompressorAverageDB-want) > 0.3 {
		t.Fatalf("average compressor reduction %.3f dB, want %.2f", stats.CompressorAverageDB, want)
	}
	if stats.LimiterPeakDB != 0 {
		t.Fatalf("disabled limiter reported %.2f dB", stats.LimiterPeakDB)
	}

	// After a reset, silence counts only while the detector decays (< 10 ms).
	e.ResetGainReductionStats()
	silent := make([]float32, 4096)
	e.ProcessBlock(silent, silent, outL[:4096], outR[:4096])
	decay := e.GainReductionStats().CompressorFrames
	e.ProcessBlock(silent, silent, outL[:4096], outR[:4096])
	if stats := e.GainReductionStats(); decay > rate/100 || stats.CompressorFrames != decay {
		t.Fatalf("silence counted: decay %d frames, then %+v", decay, stats)
	}

	// A -1 dBFS ceiling against a 0 dBFS square: the sample limiter needs 1 dB.
	p.Compressor.Enabled = false
	p.Limiter = LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 80}
	e = NewEngine(rate)
	e.SetParams(p)
	square := make([]float32, rate)
	for i := range square {
		square[i] = 1
		if (i/24)%2 == 1 {
			square[i] = -1
		}
	}
	e.ProcessBlock(square, square, make([]float32, rate), make([]float32, rate))
	if peak := e.GainReductionStats().LimiterPeakDB; math.Abs(peak-1) > 0.01 {
		t.Fatalf("limiter peak reduction %.3f dB, want 1", peak)
	}
	e.Reset()
	if stats := e.GainReductionStats(); stats != (GainReductionStats{}) {
		t.Fatalf("Reset kept statistics %+v", stats)
	}
}
