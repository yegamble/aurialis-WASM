package main

// cspell:words antiphase retarget

import (
	"math"
	"testing"
)

func TestMonitorFadeAlignmentAndHeadroom(t *testing.T) {
	var m liveMonitor
	if m.setMode(1, 8000) != 1 || m.setMode(3, 8000) != 0 {
		t.Fatal("mode acceptance")
	}
	for channel := range m.channels {
		for frame := range m.channels[channel] {
			if channel%2 == 0 {
				m.channels[channel][frame] = 1
			} else {
				m.channels[channel][frame] = -1
			}
		}
	}
	if m.process() != 128 {
		t.Fatal("process")
	}
	for i := 0; i < 128; i++ {
		want := float32(1 - math.Min(1, float64(i+1)/80))
		if math.Abs(float64(m.channels[0][i]-want)) > 1e-6 || m.channels[0][i] != m.channels[2][i] || m.channels[1][i] != m.channels[3][i] {
			t.Fatalf("unaligned fade frame %d", i)
		}
	}
	if m.setMode(2, 8000) != 1 {
		t.Fatal("side")
	}
	m.reset()
	for i := range 128 {
		m.channels[0][i] = 1
		m.channels[1][i] = -1
		m.channels[2][i] = 1
		m.channels[3][i] = -1
	}
	m.process()
	for channel := range m.channels {
		for _, s := range m.channels[channel] {
			if s != 1 {
				t.Fatal("side is not unity antiphase")
			}
		}
	}
}

func TestMonitorRetargetResetAndInvalidAtomic(t *testing.T) {
	var m liveMonitor
	m.setMode(1, 48000)
	m.process()
	current := m.current
	m.channels[3][127] = float32(math.NaN())
	remaining := m.remaining
	if m.process() != 0 || m.remaining != remaining || m.current != current {
		t.Fatal("invalid input changed fade")
	}
	m.channels[3][127] = 0
	m.setMode(2, 48000)
	if m.current != current {
		t.Fatal("retarget discontinuity")
	}
	m.reset()
	if m.remaining != 0 || m.current != monitorMatrix(2) {
		t.Fatal("reset lost desired mode")
	}
	if m.buffer(4) != nil {
		t.Fatal("invalid buffer")
	}
	if allocs := testing.AllocsPerRun(100, func() { m.process() }); allocs != 0 {
		t.Fatalf("%g allocations", allocs)
	}
}
