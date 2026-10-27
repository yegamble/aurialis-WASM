package dsp

// compressorStatsGate is the detector level (-60 dBFS) below which a frame
// does not count towards the average: silence and fades would dilute it.
const compressorStatsGate = 1e-3

// GainReductionStats summarizes the gain reduction of every processed sample
// since the engine was created, Reset or ResetGainReductionStats.
type GainReductionStats struct {
	// CompressorFrames counts frames whose compressor detector read above -60 dBFS.
	CompressorFrames int64 `json:"compressorFrames"`
	// CompressorAverageDB is the mean compressor reduction over those frames.
	CompressorAverageDB float64 `json:"compressorAverageDb"`
	// LimiterPeakDB is the largest limiter reduction applied to any frame.
	LimiterPeakDB float64 `json:"limiterPeakDb"`
}

type grStatsState struct {
	compressorFrames int64
	compressorSumDB  float64
	limiterPeakDB    float64
}

func (s *grStatsState) observe(compActive bool, detector, compressorDB, limiterDB float64) {
	if compActive && detector > compressorStatsGate {
		s.compressorFrames++
		s.compressorSumDB += compressorDB
	}
	if limiterDB > s.limiterPeakDB {
		s.limiterPeakDB = limiterDB
	}
}

// GainReductionStats returns the statistics gathered so far without changing them.
func (e *Engine) GainReductionStats() GainReductionStats {
	stats := GainReductionStats{CompressorFrames: e.grStats.compressorFrames, LimiterPeakDB: e.grStats.limiterPeakDB}
	if stats.CompressorFrames > 0 {
		stats.CompressorAverageDB = e.grStats.compressorSumDB / float64(stats.CompressorFrames)
	}
	return stats
}

// ResetGainReductionStats starts a new measurement without touching audio state.
func (e *Engine) ResetGainReductionStats() { e.grStats = grStatsState{} }
