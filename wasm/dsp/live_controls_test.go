package main

import (
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func neutralLiveControls() liveControlVector {
	return liveControlVector{
		0, 0, 0, 0, 1,
		60, 0, .707, 1, 1,
		250, 0, 1, 2, 1,
		1000, 0, 1, 2, 1,
		4000, 0, 1.2, 2, 1,
		12000, 0, .707, 3, 1,
		1, 0, 1, 18, 140, 3, 0, 90, 0,
		1, 0, 0,
		1, 100, 0, 110,
		0, -1, -14, 80, 1,
		0, 0, 0, 0,
		0,
	}
}

func TestLiveControlsRepresentEveryParameter(t *testing.T) {
	controls := neutralLiveControls()
	params, accepted := controls.params()
	if !accepted || params != dsp.DefaultParams() {
		t.Fatal("neutral controls do not represent canonical defaults")
	}
	controls = liveControlVector{
		1, 1, 1, 3, 0,
		40, -2, .5, 0, 0,
		300, 2, .8, 1, 1,
		1500, -3, 2, 2, 0,
		5000, 4, 3, 3, 1,
		14000, 1, 1.5, 2, 0,
		0, -30, 4, 2, 200, 6, 5, 120, 3,
		0, 40, 2,
		0, 120, 1, 150,
		1, -2, -12, 120, 0,
		1, 5, -4, 1,
		24,
	}
	want := dsp.Params{
		Bypass: true, ABOriginal: true, LoudnessMatchAB: true, InputGainDB: 3, EQEnabled: false,
		Bands: [5]dsp.BandParams{
			{FreqHz: 40, GainDB: -2, Q: .5, Type: dsp.FilterHighPass, Enabled: false},
			{FreqHz: 300, GainDB: 2, Q: .8, Type: dsp.FilterLowShelf, Enabled: true},
			{FreqHz: 1500, GainDB: -3, Q: 2, Type: dsp.FilterPeaking, Enabled: false},
			{FreqHz: 5000, GainDB: 4, Q: 3, Type: dsp.FilterHighShelf, Enabled: true},
			{FreqHz: 14000, GainDB: 1, Q: 1.5, Type: dsp.FilterPeaking, Enabled: false},
		},
		Compressor: dsp.CompressorParams{Enabled: false, ThresholdDB: -30, Ratio: 4, AttackMS: 2, ReleaseMS: 200, KneeDB: 6, MakeupDB: 5, SidechainHPFHz: 120, Topology: dsp.CompVCA},
		Saturation: dsp.SaturationParams{Enabled: false, Amount: 40, Character: dsp.SatCrisp},
		Stereo:     dsp.StereoParams{Enabled: false, WidthPct: 120, MonoBass: true, CrossoverHz: 150},
		Limiter:    dsp.LimiterParams{Enabled: true, CeilingDBTP: -2, TargetLUFS: -12, ReleaseMS: 120, TruePeak: false},
		Repair:     dsp.RepairParams{Enabled: true, DeEssDB: 5, TransientDB: -4, DeClip: true}, DitherBits: 24,
	}
	params, accepted = controls.params()
	if !accepted || params != want {
		t.Fatal("numeric controls omitted or changed a canonical parameter")
	}
}

func TestLiveControlsRejectInvalidValuesWithoutMutation(t *testing.T) {
	bridge := NewBridge(44100)
	valid := neutralLiveControls()
	valid[31], valid[32], valid[40], valid[41] = -24, 4, 30, 2
	if valid.apply(bridge) != 1 {
		t.Fatal("valid active controls rejected")
	}
	blocks := liveBlockBridge{bridge: bridge}
	for i := range blocks.channels[0] {
		blocks.channels[0][i] = float32(.2 * math.Sin(float64(i)*.3))
		blocks.channels[1][i] = float32(.15 * math.Cos(float64(i)*.2))
	}
	if blocks.process() != 128 {
		t.Fatal("initial block rejected")
	}
	before := *bridge.engine
	assertRejected := func(vector liveControlVector) {
		t.Helper()
		if vector.apply(bridge) != 0 || *bridge.engine != before {
			t.Fatal("invalid control vector changed settings or DSP history")
		}
	}
	for index := range valid {
		for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
			vector := valid
			vector[index] = value
			assertRejected(vector)
		}
	}
	for _, index := range [...]int{0, 1, 2, 4, 9, 14, 19, 24, 29, 30, 39, 42, 44, 46, 50, 51, 54} {
		for _, value := range []float64{-1, .5, 2} {
			vector := valid
			vector[index] = value
			assertRejected(vector)
		}
	}
	for _, index := range [...]int{8, 13, 18, 23, 28, 38, 41} {
		for _, value := range []float64{-1, .5, 4} {
			vector := valid
			vector[index] = value
			assertRejected(vector)
		}
	}
	for _, entry := range []struct {
		index int
		value float64
	}{
		{3, 37}, {5, 9}, {6, 25}, {7, .09}, {31, -81}, {32, .5},
		{33, 0}, {34, 4}, {35, 25}, {36, 37}, {37, 1001}, {40, 101},
		{41, 3}, {43, 201}, {45, 19}, {47, 1}, {48, -4}, {49, 9},
		{52, 25}, {53, -25}, {55, .5}, {55, 8}, {55, 32},
	} {
		vector := valid
		vector[entry.index] = entry.value
		assertRejected(vector)
	}
	if valid.apply(nil) != 0 {
		t.Fatal("uninitialized bridge accepted controls")
	}
}

func TestLiveControlEnumsAndDither(t *testing.T) {
	for filter := 0; filter < 4; filter++ {
		for topology := 0; topology < 4; topology++ {
			for character := 0; character < 3; character++ {
				for _, bits := range []float64{0, 16, 24} {
					vector := neutralLiveControls()
					for _, index := range [...]int{8, 13, 18, 23, 28} {
						vector[index] = float64(filter)
					}
					vector[38], vector[41], vector[55] = float64(topology), float64(character), bits
					if _, accepted := vector.params(); !accepted {
						t.Fatal("supported enum combination rejected")
					}
				}
			}
		}
	}
}

func TestLiveControlsAndResetAllocateNothingOnValidUpdates(t *testing.T) {
	bridge := NewBridge(48000)
	controls := neutralLiveControls()
	controls[31], controls[32], controls[40], controls[41] = -24, 4, 30, 2
	blocks := liveBlockBridge{bridge: bridge}
	for i := range blocks.channels[0] {
		blocks.channels[0][i] = float32(.2 * math.Sin(float64(i)*.3))
		blocks.channels[1][i] = float32(.1 * math.Cos(float64(i)*.2))
	}
	if allocations := testing.AllocsPerRun(1000, func() {
		controls[3] = 1 - controls[3]
		if controls.apply(bridge) != 1 || blocks.process() != 128 || blocks.reset() != 1 {
			panic("valid control/process/reset rejected")
		}
	}); allocations != 0 {
		t.Fatalf("valid control/process/reset allocated %g times", allocations)
	}
	before := bridge.Params()
	blocks.reset()
	if bridge.Params() != before {
		t.Fatal("reset changed control settings")
	}
}

func TestLiveSampleRateBounds(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		if !validLiveSampleRate(rate) {
			t.Fatal("supported sample rate rejected")
		}
	}
	for _, rate := range []float64{0, 7999, 192001, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if validLiveSampleRate(rate) {
			t.Fatal("invalid sample rate accepted")
		}
	}
}
