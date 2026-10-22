// Package main compiles the Aurialis-WASM real-time DSP engine to WebAssembly
// (GOOS=js/wasip1 GOARCH=wasm) and exposes a stateful block-processing bridge.
package main

import (
	"sync"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// Bridge wraps a dsp.Engine instance with thread-safe JSON/parameter updates
// and reusable scratch buffers for WebAssembly AudioWorklet block processing.
type Bridge struct {
	mu       sync.Mutex
	engine   *dsp.Engine
	scratchL []float32
	scratchR []float32
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
}

// Reset zeroes all internal filter and detector states.
func (b *Bridge) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.engine.Reset()
}

// SetParamsJSON parses a JSON-encoded dsp.Params payload and updates the engine.
func (b *Bridge) SetParamsJSON(rawJSON string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	current, err := dsp.DecodeParamsJSON([]byte(rawJSON), b.engine.Params())
	if err != nil {
		return err
	}
	b.engine.SetParams(current)
	return nil
}

// SetParams updates the DSP parameter vector directly.
func (b *Bridge) SetParams(params dsp.Params) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.engine.SetParams(params)
}

// SetBand updates a single parametric EQ band [0..4] without altering any other parameter.
func (b *Bridge) SetBand(index int, band dsp.BandParams) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.engine.SetBand(index, band)
}

// Params returns a copy of the active DSP parameter struct.
func (b *Bridge) Params() dsp.Params {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.engine.Params()
}

// ProcessBlock executes one real-time stereo block through the DSP engine.
func (b *Bridge) ProcessBlock(inL, inR, outL, outR []float32) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.engine.ProcessBlock(inL, inR, outL, outR)
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
