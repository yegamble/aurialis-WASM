package main

import (
	"math"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// liveControlValues is the complete fixed numeric control ABI. Values are
// float64 so the interface does not round the shared engine's parameters.
const liveControlValues = 56

type liveControlVector [liveControlValues]float64

// Layout: global flags/gain/EQ [0:5]; five EQ bands, each frequency/gain/Q/type/
// enabled [5:30]; compressor [30:39]; saturation [39:42]; stereo [42:46];
// limiter [46:51]; repair [51:55]; dither bits [55]. Boolean values are exactly
// zero or one. Filter, compressor and saturation enum order is declared below.
// A rejected vector cannot change settings or processing history.
func (v *liveControlVector) apply(bridge *Bridge) uint32 {
	if bridge == nil {
		return 0
	}
	params, accepted := v.params()
	if !accepted {
		return 0
	}
	bridge.SetParams(params)
	return 1
}

func (v *liveControlVector) params() (dsp.Params, bool) {
	for _, value := range v {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return dsp.Params{}, false
		}
	}
	for _, index := range [...]int{0, 1, 2, 4, 9, 14, 19, 24, 29, 30, 39, 42, 44, 46, 50, 51, 54} {
		if v[index] != 0 && v[index] != 1 {
			return dsp.Params{}, false
		}
	}
	for _, index := range [...]int{8, 13, 18, 23, 28, 38} {
		if !liveControlEnum(v[index], 4) {
			return dsp.Params{}, false
		}
	}
	if !liveControlEnum(v[41], 3) || (v[55] != 0 && v[55] != 16 && v[55] != 24) {
		return dsp.Params{}, false
	}

	filters := [...]dsp.FilterType{dsp.FilterHighPass, dsp.FilterLowShelf, dsp.FilterPeaking, dsp.FilterHighShelf}
	topologies := [...]dsp.CompTopology{dsp.CompOptical, dsp.CompVariableMu, dsp.CompFET, dsp.CompVCA}
	characters := [...]dsp.SatCharacter{dsp.SatWarm, dsp.SatThick, dsp.SatCrisp}
	params := dsp.Params{
		Bypass: v[0] == 1, ABOriginal: v[1] == 1, LoudnessMatchAB: v[2] == 1,
		InputGainDB: v[3], EQEnabled: v[4] == 1,
	}
	for index := range params.Bands {
		offset := 5 + index*5
		params.Bands[index] = dsp.BandParams{
			FreqHz: v[offset], GainDB: v[offset+1], Q: v[offset+2],
			Type: filters[int(v[offset+3])], Enabled: v[offset+4] == 1,
		}
	}
	params.Compressor = dsp.CompressorParams{
		Enabled: v[30] == 1, ThresholdDB: v[31], Ratio: v[32], AttackMS: v[33],
		ReleaseMS: v[34], KneeDB: v[35], MakeupDB: v[36], SidechainHPFHz: v[37],
		Topology: topologies[int(v[38])],
	}
	params.Saturation = dsp.SaturationParams{Enabled: v[39] == 1, Amount: v[40], Character: characters[int(v[41])]}
	params.Stereo = dsp.StereoParams{Enabled: v[42] == 1, WidthPct: v[43], MonoBass: v[44] == 1, CrossoverHz: v[45]}
	params.Limiter = dsp.LimiterParams{
		Enabled: v[46] == 1, CeilingDBTP: v[47], TargetLUFS: v[48], ReleaseMS: v[49], TruePeak: v[50] == 1,
	}
	params.Repair = dsp.RepairParams{Enabled: v[51] == 1, DeEssDB: v[52], TransientDB: v[53], DeClip: v[54] == 1}
	params.DitherBits = int(v[55])
	if dsp.ValidateParams(params) != nil {
		return dsp.Params{}, false
	}
	return params, true
}

func liveControlEnum(value float64, count int) bool {
	return value >= 0 && value < float64(count) && value == math.Trunc(value)
}

func validLiveSampleRate(rate float64) bool {
	return !math.IsNaN(rate) && !math.IsInf(rate, 0) && rate >= 8000 && rate <= 192000
}
