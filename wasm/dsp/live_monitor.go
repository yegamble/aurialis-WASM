package main

import (
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// liveMonitor runs after host latency alignment, tail selection and A/B mixing.
// Pair 0/1 carries the selected pre-match meter signal; pair 2/3 is audible PCM.
// It never feeds back into DSP, tail or export state.
type liveMonitor struct {
	channels        [4][liveBlockFrames]float32
	mode            dsp.MonitorMode
	current, target [4]float64
	remaining       int
	initialized     bool
}

func monitorMatrix(mode dsp.MonitorMode) [4]float64 {
	switch mode {
	case dsp.MonitorMono:
		return [4]float64{0.5, 0.5, 0.5, 0.5}
	case dsp.MonitorSide:
		return [4]float64{0.5, -0.5, 0.5, -0.5}
	case dsp.MonitorStereo:
		return [4]float64{1, 0, 0, 1}
	}
	return [4]float64{1, 0, 0, 1}
}

func (m *liveMonitor) reset() {
	m.current = monitorMatrix(m.mode)
	m.target = m.current
	m.remaining = 0
	m.initialized = true
}

func (m *liveMonitor) setMode(mode uint32, rate float64) uint32 {
	if mode > uint32(dsp.MonitorSide) {
		return 0
	}
	if !m.initialized {
		m.reset()
	}
	if m.mode == dsp.MonitorMode(mode) {
		return 1
	}
	m.mode = dsp.MonitorMode(mode)
	m.target = monitorMatrix(m.mode)
	m.remaining = max(1, int(math.Round(rate*0.01)))
	return 1
}

func (m *liveMonitor) buffer(channel uint32) *[liveBlockFrames]float32 {
	if channel >= uint32(len(m.channels)) {
		return nil
	}
	return &m.channels[channel]
}

func (m *liveMonitor) process() uint32 {
	// Validate before advancing the fade or changing any pair.
	for channel := range m.channels {
		for _, sample := range m.channels[channel] {
			if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
				return 0
			}
		}
	}
	if !m.initialized {
		m.reset()
	}
	if m.remaining == 0 && m.mode == dsp.MonitorStereo {
		return liveBlockFrames
	}
	for frame := range liveBlockFrames {
		if m.remaining > 0 {
			for coefficient := range m.current {
				m.current[coefficient] += (m.target[coefficient] - m.current[coefficient]) / float64(m.remaining)
			}
			m.remaining--
			if m.remaining == 0 {
				m.current = m.target
			}
		}
		for pair := 0; pair < 4; pair += 2 {
			l, r := float64(m.channels[pair][frame]), float64(m.channels[pair+1][frame])
			m.channels[pair][frame] = float32(m.current[0]*l + m.current[1]*r)
			m.channels[pair+1][frame] = float32(m.current[2]*l + m.current[3]*r)
		}
	}
	return liveBlockFrames
}
