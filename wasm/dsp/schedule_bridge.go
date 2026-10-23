// cspell:words automator

package main

import (
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

const scheduleSourceValues = 11
const scheduleMoveValues = 4 + 2*automation.MaxPoints

type sourceBinding struct {
	rate   int
	frames int64
	hash   [8]uint32
}
type scheduleSourceVector [scheduleSourceValues]float64
type scheduleMoveVector [scheduleMoveValues]float64

func integer(value, low, high float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= low && value <= high && value == math.Trunc(value)
}
func (vector *scheduleSourceVector) binding() (sourceBinding, bool) {
	if vector[0] != 1 || !integer(vector[1], 8000, 192000) || !integer(vector[2], 1, automation.MaxSourceFrames) {
		return sourceBinding{}, false
	}
	binding := sourceBinding{rate: int(vector[1]), frames: int64(vector[2])}
	for i := range binding.hash {
		if !integer(vector[i+3], 0, math.MaxUint32) {
			return sourceBinding{}, false
		}
		binding.hash[i] = uint32(vector[i+3])
	}
	return binding, true
}
func (vector *scheduleMoveVector) stage(bridge *Bridge, index uint32) bool {
	if !integer(vector[0], 0, automation.TargetCount-1) || !integer(vector[1], 2, automation.MaxPoints) || !integer(vector[2], 0, 19200) || (vector[3] != 0 && vector[3] != 1) {
		return false
	}
	var points [automation.MaxPoints]automation.Point
	count := int(vector[1])
	for i := range count {
		if !integer(vector[4+2*i], 0, automation.MaxSourceFrames) {
			return false
		}
		points[i] = automation.Point{Frame: int64(vector[4+2*i]), Value: vector[5+2*i]}
	}
	return bridge.stageScheduleMove(int(index), automation.Target(vector[0]), int(vector[2]), vector[3] == 1, points[:count])
}

func (b *Bridge) bindSource(source sourceBinding) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil {
		return false
	}
	b.source, b.sourceBound, b.acceptedRevision, b.pending = source, true, 0, false
	b.engine.Reset()
	return true
}
func (b *Bridge) beginSchedule(source sourceBinding, revision uint64, count int, baseline dsp.Params) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.sourceBound || source != b.source || revision <= b.acceptedRevision || dsp.ValidateParams(baseline) != nil {
		return false
	}
	slot := 1 - b.activeSlot
	if !b.scheduleSlots[slot].Begin(source.rate, int(b.engine.SampleRate()), source.frames, revision, automator.ValuesOf(baseline), count) {
		return false
	}
	b.pendingSlot, b.pendingBaseline, b.pending = slot, baseline, true
	return true
}
func (b *Bridge) stageScheduleMove(index int, target automation.Target, fade int, muted bool, points []automation.Point) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pending && b.scheduleSlots[b.pendingSlot].Stage(index, target, fade, muted, points)
}
func (b *Bridge) commitSchedule() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.pending {
		return false
	}
	schedule, accepted := b.scheduleSlots[b.pendingSlot].Finalize()
	if !accepted || schedule.Revision() <= b.acceptedRevision {
		return false
	}
	processor := &b.processors[b.pendingSlot]
	if !processor.ConfigureAt(b.engine, b.pendingBaseline, schedule, b.activeProcessor) {
		return false
	}
	b.activeProcessor, b.activeSlot, b.activeBaseline, b.acceptedRevision, b.pending = processor, b.pendingSlot, b.pendingBaseline, schedule.Revision(), false
	return true
}
func (b *Bridge) scheduleRevision() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.acceptedRevision
}
func (b *Bridge) seekSchedule(sourceFrame int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.activeProcessor != nil && b.activeProcessor.SeekSourceFrame(sourceFrame) == nil
}
func (b *Bridge) detachSchedule() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil {
		b.engine.SetParams(b.activeBaseline)
	}
	b.activeProcessor = nil
	b.pending = false
	return true
}

func (b *Bridge) setScheduleLooping(enabled bool) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor == nil {
		return false
	}
	b.activeProcessor.SetLooping(enabled)
	return true
}
