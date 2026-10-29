package dsp

import (
	"context"
	"math"
	"reflect"
	"testing"
)

func TestMonitorMeasurementsMatchExplicitMatrixWithoutMutation(t *testing.T) {
	l, r := make([]float32, 4096), make([]float32, 4096)
	for i := range l {
		l[i] = float32(.4 * math.Sin(float64(i)*.37))
		r[i] = float32(.2 * math.Cos(float64(i)*.51))
	}
	originalL, originalR := append([]float32{}, l...), append([]float32{}, r...)
	for _, mode := range []MonitorMode{MonitorStereo, MonitorMono, MonitorSide} {
		ml, mr := make([]float32, len(l)), make([]float32, len(l))
		for i := range l {
			switch mode {
			case MonitorMono:
				ml[i] = float32((float64(l[i]) + float64(r[i])) / 2)
				mr[i] = ml[i]
			case MonitorSide:
				ml[i] = float32((float64(l[i]) - float64(r[i])) / 2)
				mr[i] = ml[i]
			case MonitorStereo:
				ml[i], mr[i] = l[i], r[i]
			}
		}
		got, err := MeasureMonitorContext(context.Background(), l, r, 8000, mode)
		if err != nil || got != MeasureStereo(ml, mr, 8000) {
			t.Fatalf("mode %d mismatch: %v", mode, err)
		}
	}
	if !reflect.DeepEqual(l, originalL) || !reflect.DeepEqual(r, originalR) {
		t.Fatal("measurement modified PCM")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := MeasureMonitorContext(ctx, l, r, 8000, MonitorMono); err == nil {
		t.Fatal("ignored cancellation")
	}
}
