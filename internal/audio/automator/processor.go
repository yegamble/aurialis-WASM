// Package automator runs one compiled schedule through the shared native/WASI DSP engine.
package automator

import (
	"errors"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// ValuesOf extracts the closed automatable fields without changing module enable states.
func ValuesOf(params dsp.Params) automation.Values {
	values := automation.Values{}
	values[automation.InputGain] = params.InputGainDB
	for i, band := range params.Bands {
		values[1+i] = band.GainDB
	}
	values[automation.CompressorThreshold], values[automation.CompressorRatio] = params.Compressor.ThresholdDB, params.Compressor.Ratio
	values[automation.SaturationAmount], values[automation.Width] = params.Saturation.Amount, params.Stereo.WidthPct
	return values
}

// Processor owns fixed scratch and a source clock; construction/compilation stays off processing.
type Processor struct {
	engine      *dsp.Engine
	schedule    *automation.Schedule
	cursor      *automation.Cursor
	gain, width [128]float64
	used        bool
}

// New validates the immutable chain/schedule binding before changing any engine history.
func New(engine *dsp.Engine, baseline dsp.Params, schedule *automation.Schedule) (*Processor, error) {
	if engine == nil || schedule == nil || dsp.ValidateParams(baseline) != nil || ValuesOf(baseline) != schedule.Baseline() || engine.SampleRate() != float64(schedule.DeviceRate()) {
		return nil, errors.New("automation baseline or device rate mismatch")
	}
	processor := &Processor{engine: engine, schedule: schedule, cursor: automation.NewCursor(schedule)}
	for target := automation.InputGain; target < automation.TargetCount; target++ {
		processor.used = processor.used || schedule.Used(target)
	}
	engine.SetParams(baseline)
	return processor, nil
}

// Revision identifies the installed immutable schedule.
func (processor *Processor) Revision() uint64 { return processor.schedule.Revision() }

// SeekSourceFrame resets DSP history and reconstructs source-time envelopes. Invalid seeks preserve both.
func (processor *Processor) SeekSourceFrame(sourceFrame int64) error {
	if err := processor.cursor.SeekSourceFrame(sourceFrame); err != nil {
		return err
	}
	processor.engine.Reset()
	return nil
}

// ProcessBlock has bounded per-sample evaluation and coefficient work independent of authored point density.
func (processor *Processor) ProcessBlock(inL, inR, outL, outR []float32) {
	count := min(len(inL), len(inR), len(outL), len(outR))
	if !processor.used {
		processor.cursor.AdvanceFrames(count)
		processor.engine.ProcessBlock(inL, inR, outL, outR)
		return
	}
	for start := 0; start < count; {
		span, values := processor.cursor.Fill(processor.gain[:], processor.width[:], min(128, count-start))
		var eq [dsp.NumEQBands]float64
		copy(eq[:], values[automation.EQ0:automation.EQ4+1])
		processor.engine.ApplyAutomationControls(eq, values[automation.CompressorThreshold], values[automation.CompressorRatio], values[automation.SaturationAmount])
		var gain, width []float64
		if processor.schedule.Used(automation.InputGain) {
			gain = processor.gain[:span]
		}
		if processor.schedule.Used(automation.Width) {
			width = processor.width[:span]
		}
		processor.engine.ProcessAutomationBlock(inL[start:start+span], inR[start:start+span], outL[start:start+span], outR[start:start+span], gain, width)
		start += span
	}
}

// InheritPosition preserves exact source phase when replacing a compatible revision.
func (processor *Processor) InheritPosition(previous *Processor) bool {
	return previous != nil && processor.cursor.CopyPosition(previous.cursor)
}
