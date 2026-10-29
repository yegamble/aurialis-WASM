package dsp

import (
	"context"
	"errors"
)

// MonitorMode selects an audition view, independent of the mastering parameters.
type MonitorMode uint32

// Supported monitoring views. These never alter mastering parameters.
const (
	MonitorStereo MonitorMode = iota
	MonitorMono
	MonitorSide
)

// ParseMonitorMode accepts the optional measurement-only request field.
func ParseMonitorMode(value string) (MonitorMode, error) {
	switch value {
	case "", "stereo":
		return MonitorStereo, nil
	case "mono":
		return MonitorMono, nil
	case "side":
		return MonitorSide, nil
	default:
		return MonitorStereo, errors.New("monitorMode must be stereo, mono or side")
	}
}

// Sample applies the no-boost monitor matrix. Mono and side play equally in both ears.
func (m MonitorMode) Sample(left, right float32) (float32, float32) {
	switch m {
	case MonitorMono:
		mid := float32((float64(left) + float64(right)) * 0.5)
		return mid, mid
	case MonitorSide:
		side := float32((float64(left) - float64(right)) * 0.5)
		return side, side
	case MonitorStereo:
		return left, right
	}
	return left, right
}

// MeasureMonitorContext measures the selected view without changing source PCM
// or allocating a full-song monitor copy. Stereo retains the export meter path.
func MeasureMonitorContext(ctx context.Context, left, right []float32, sampleRate float64, mode MonitorMode) (Metrics, error) {
	if ctx == nil {
		return Metrics{}, errors.New("measurement context must not be nil")
	}
	if mode > MonitorSide {
		return Metrics{}, errors.New("invalid monitor mode")
	}
	if err := ctx.Err(); err != nil {
		return Metrics{}, err
	}
	return measureMonitorContext(ctx, left, right, sampleRate, mode)
}
