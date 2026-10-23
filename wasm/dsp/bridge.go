// Package main compiles the Aurialis-WASM real-time DSP engine to WebAssembly
// (GOOS=js/wasip1 GOARCH=wasm) and exposes a stateful block-processing bridge.
package main

import (
	"errors"
	"sync"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automator"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// Bridge wraps a dsp.Engine instance with thread-safe JSON/parameter updates
// and reusable scratch buffers for WebAssembly AudioWorklet block processing.
type Bridge struct {
	mu               sync.Mutex
	engine           *dsp.Engine
	scratchL         []float32
	scratchR         []float32
	scheduleSlots    [2]automation.Builder
	processors       [2]automator.Processor
	activeProcessor  *automator.Processor
	activeSlot       int
	source           sourceBinding
	sourceBound      bool
	sourceClock      automation.Cursor
	acceptedRevision uint64
	pendingSlot      int
	pending          bool
	pendingBaseline  dsp.Params
	activeBaseline   dsp.Params
}

// NewBridge creates a new WASM DSP bridge at the specified sample rate.
func NewBridge(sampleRate float64) *Bridge {
	return &Bridge{
		engine:   dsp.NewEngine(sampleRate),
		scratchL: make([]float32, 4096),
		scratchR: make([]float32, 4096),
	}
}

// Init re-initializes the underlying DSP engine at a new sample rate.
func (b *Bridge) Init(sampleRate float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.engine = dsp.NewEngine(sampleRate)
	b.activeProcessor = nil
	b.sourceBound = false
	b.sourceClock = automation.Cursor{}
	b.acceptedRevision = 0
	b.pending = false
}

// Reset zeroes filter/detector history and seeks a bound source clock to zero.
// Source identity, loop policy, attached schedule and accepted revision are retained.
func (b *Bridge) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sourceBound {
		_ = b.sourceClock.SeekSourceFrame(0)
	}
	if b.activeProcessor != nil {
		_ = b.activeProcessor.SeekSourceFrame(0)
	} else {
		b.engine.Reset()
	}
}

// SetParamsJSON parses a JSON-encoded dsp.Params payload and updates the engine.
func (b *Bridge) SetParamsJSON(rawJSON string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil {
		return errors.New("detach automation or publish a complete baseline/schedule revision")
	}
	current, err := dsp.DecodeParamsJSON([]byte(rawJSON), b.engine.Params())
	if err != nil {
		return err
	}
	b.engine.SetParams(current)
	return nil
}

// SetParams updates the DSP parameter vector directly.
func (b *Bridge) SetParams(params dsp.Params) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil || dsp.ValidateParams(params) != nil {
		return false
	}
	b.engine.SetParams(params)
	return true
}

// SetBand updates a single parametric EQ band [0..4] without altering any other parameter.
func (b *Bridge) SetBand(index int, band dsp.BandParams) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil || index < 0 || index >= dsp.NumEQBands {
		return false
	}
	next := b.engine.Params()
	next.Bands[index] = band
	if dsp.ValidateParams(next) != nil {
		return false
	}
	b.engine.SetBand(index, band)
	return true
}

// Params returns a copy of the active DSP parameter struct.
func (b *Bridge) Params() dsp.Params {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.engine.Params()
}

// ProcessBlock executes one real-time stereo block through the DSP engine.
// Once bound, every processed device frame advances source phase, including
// static/bypassed playback. Hosts call no processing before the epoch or while paused.
func (b *Bridge) ProcessBlock(inL, inR, outL, outR []float32) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeProcessor != nil {
		if !b.activeProcessor.ProcessBlock(inL, inR, outL, outR) {
			return false
		}
		return b.activeProcessor.CopyPositionTo(&b.sourceClock)
	}
	b.engine.ProcessBlock(inL, inR, outL, outR)
	if b.sourceBound {
		b.sourceClock.AdvanceFrames(min(len(inL), len(inR), len(outL), len(outR)))
	}
	return true
}

// Measure computes gated K-weighted loudness, FIR inter-sample peak,
// crest factor, and stereo correlation estimates.
func (b *Bridge) Measure(left, right []float32) dsp.Metrics {
	b.mu.Lock()
	sr := b.engine.SampleRate()
	gr := b.engine.LastGainReductionDB()
	b.mu.Unlock()
	m := dsp.MeasureStereo(left, right, sr)
	m.GainReductionDB = gr
	return m
}

// LatencyFrames reports buffered DSP delay, excluding transport delay.
func (b *Bridge) LatencyFrames() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.engine.LatencyFrames()
}

// Drain writes only buffered tail frames and returns their count.
func (b *Bridge) Drain(outL, outR []float32) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.engine.Drain(outL, outR)
}

// SampleRate returns the current processing rate for compiled schedule binding.
func (b *Bridge) SampleRate() float64 { b.mu.Lock(); defer b.mu.Unlock(); return b.engine.SampleRate() }
