package main

import (
	"context"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// liveVector packs params into the ABI 2 control vector the worklet sends
// (src/lib/live-controls.ts packLiveControls), algorithm slot included.
func liveVector(p dsp.Params) liveVersionedControlVector {
	flag := func(value bool) float64 {
		if value {
			return 1
		}
		return 0
	}
	code := func(value any, values ...any) float64 {
		for index, candidate := range values {
			if candidate == value {
				return float64(index)
			}
		}
		panic("unknown enum value")
	}
	var v liveVersionedControlVector
	v[0], v[1], v[3], v[4] = flag(p.Bypass), flag(p.ABOriginal), p.InputGainDB, flag(p.EQEnabled)
	for i, band := range p.Bands {
		o := 5 + i*5
		v[o], v[o+1], v[o+2], v[o+4] = band.FreqHz, band.GainDB, band.Q, flag(band.Enabled)
		v[o+3] = code(band.Type, dsp.FilterHighPass, dsp.FilterLowShelf, dsp.FilterPeaking, dsp.FilterHighShelf)
	}
	c := p.Compressor
	v[30], v[31], v[32], v[33], v[34], v[35], v[36], v[37] = flag(c.Enabled), c.ThresholdDB, c.Ratio, c.AttackMS, c.ReleaseMS, c.KneeDB, c.MakeupDB, c.SidechainHPFHz
	v[38] = code(c.Topology, dsp.CompOptical, dsp.CompVariableMu, dsp.CompFET, dsp.CompVCA)
	v[39], v[40] = flag(p.Saturation.Enabled), p.Saturation.Amount
	v[41] = code(p.Saturation.Character, dsp.SatWarm, dsp.SatThick, dsp.SatCrisp, dsp.SatClean, dsp.SatTube, dsp.SatTape, dsp.SatTransformer)
	v[42], v[43], v[44], v[45] = flag(p.Stereo.Enabled), p.Stereo.WidthPct, flag(p.Stereo.MonoBass), p.Stereo.CrossoverHz
	l := p.Limiter
	v[46], v[47], v[48], v[49], v[50] = flag(l.Enabled), l.CeilingDBTP, l.TargetLUFS, l.ReleaseMS, flag(l.TruePeak)
	v[51], v[52], v[53], v[54] = flag(p.Repair.Enabled), p.Repair.DeEssDB, p.Repair.TransientDB, flag(p.Repair.DeClip)
	v[55], v[56], v[57], v[58] = float64(p.DitherBits), flag(c.AutoRelease), p.Stereo.MidGainDB, p.Stereo.SideGainDB
	v[59], v[60], v[61], v[62] = flag(p.DeHarsh.Enabled), p.DeHarsh.FrequencyHz, p.DeHarsh.ThresholdDB, p.DeHarsh.RangeDB
	v[63], v[64], v[65] = flag(p.Multiband.Enabled), p.Multiband.LowMidHz, p.Multiband.MidHighHz
	for i, band := range p.Multiband.Bands {
		o := 66 + i*5
		v[o], v[o+1], v[o+2], v[o+3], v[o+4] = band.ThresholdDB, band.Ratio, band.AttackMS, band.ReleaseMS, band.MakeupDB
	}
	v[liveControlValues] = float64(p.AlgorithmVersion)
	return v
}

// livePlayback renders a source the way the worklet plays it: ABI 2 controls,
// 128-frame quanta, the source's end marked (aurialis_live_end_input) in the
// quantum that holds it, silent quanta after it, and the processed ring read
// the engine's latency ahead of the dry ring so A lines up with B.
// It returns what is heard for each source frame and the live meter snapshot.
func livePlayback(t *testing.T, rate float64, left, right []float32, params dsp.Params) ([]float32, []float32, dsp.LiveLoudness) {
	t.Helper()
	blocks := liveBlockBridge{bridge: NewBridge(rate)}
	vector := liveVector(params)
	if vector.apply(blocks.bridge, liveVersionedControlValues) != 1 || blocks.reset() != 1 {
		t.Fatal("live controls rejected")
	}
	latency := blocks.bridge.LatencyFrames()
	frames := len(left)
	processed := [2][]float32{make([]float32, 0, frames+latency+liveBlockFrames), make([]float32, 0, frames+latency+liveBlockFrames)}
	for start := 0; len(processed[0]) < frames+latency; start += liveBlockFrames {
		for frame := range liveBlockFrames {
			blocks.channels[0][frame], blocks.channels[1][frame] = 0, 0
			if start+frame < frames {
				blocks.channels[0][frame], blocks.channels[1][frame] = left[start+frame], right[start+frame]
			}
		}
		if start <= frames && frames < start+liveBlockFrames && blocks.endInput(uint32(frames-start)) != 1 {
			t.Fatal("source end rejected")
		}
		if blocks.process() != liveBlockFrames {
			t.Fatal("live quantum rejected")
		}
		processed[0] = append(processed[0], blocks.channels[2][:]...)
		processed[1] = append(processed[1], blocks.channels[3][:]...)
	}
	blocks.meterSnapshot()
	return processed[0][latency : latency+frames], processed[1][latency : latency+frames], blocks.meter.Snapshot()
}

func residualDB(got, want [2][]float32) float64 {
	var difference, signal float64
	for channel := range got {
		for i := range got[channel] {
			d := float64(got[channel][i]) - float64(want[channel][i])
			difference += d * d
			signal += float64(want[channel][i]) * float64(want[channel][i])
		}
	}
	if difference == 0 {
		return math.Inf(-1)
	}
	return 10 * math.Log10(difference/signal)
}

// V1-10 acceptance: live playback renders the export algorithm, so what is
// heard is what is exported. Through the worklet's ABI and 128-frame quanta,
// heard A matches the export render within −60 dB residual and 0.1 LU, and the
// live true-peak meter, which reads after the true-peak limiter, reads what the
// export measures and stays within 0.1 dB of the ceiling.
//
// Known export-path margin, not a live difference: with every module on but
// saturation at 0.6% (so noise hats keep their near-Nyquist energy) the BS.1770
// 4x meter read −0.75 dBTP at 48 kHz on export and live alike, where an
// independent 32x reconstruction read −1.00 dBTP.
func TestLivePlaybackRendersTheExport(t *testing.T) {
	hot := dsp.DefaultParams()
	hot.AlgorithmVersion, hot.InputGainDB = dsp.TruePeakAlgorithmVersion, 15
	hot.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -9, ReleaseMS: 80, TruePeak: true}
	cases := map[string]dsp.Params{
		"hot limiter":     hot,
		"every module on": heaviestLiveParams(dsp.TruePeakAlgorithmVersion, dsp.SatTube),
	}
	// The race detector makes this about 9x slower (502 s locally); under it
	// one rate and a 3 s mix keep the check, and CI runs all three rates at
	// 12 s without the detector.
	rates, seconds := []float64{44100, 48000, 96000}, 12
	if raceEnabled {
		rates, seconds = []float64{48000}, 3
	}
	for _, rate := range rates {
		left, right := denseMix(rate, seconds)
		for name, params := range cases {
			heardL, heardR, meter := livePlayback(t, rate, left, right, params)
			exportL, exportR, exported := dsp.RenderBuffer(left, right, rate, params)
			residual := residualDB([2][]float32{heardL, heardR}, [2][]float32{exportL, exportR})
			heard := dsp.MeasureStereo(heardL, heardR, rate)
			deltaLUFS := heard.IntegratedLUFS - exported.IntegratedLUFS
			meterDelta := meter.IntegratedLUFS - exported.IntegratedLUFS
			t.Logf("%.0f Hz %s: residual %.1f dB, LUFS delta %.4f (meter %.4f), live TP meter %.3f dBTP, export TP %.3f dBTP",
				rate, name, residual, deltaLUFS, meterDelta, meter.TruePeakDBTP, exported.TruePeakDBTP)
			if residual > -60 {
				t.Errorf("%.0f Hz %s: live vs export residual %.1f dB", rate, name, residual)
			}
			if math.Abs(deltaLUFS) > 0.1 || math.Abs(meterDelta) > 0.1 {
				t.Errorf("%.0f Hz %s: LUFS delta %.3f, live meter LUFS delta %.3f", rate, name, deltaLUFS, meterDelta)
			}
			if math.Abs(meter.TruePeakDBTP-exported.TruePeakDBTP) > 0.01 {
				t.Errorf("%.0f Hz %s: live TP meter %.3f dBTP, export %.3f dBTP", rate, name, meter.TruePeakDBTP, exported.TruePeakDBTP)
			}
			if ceiling := params.Limiter.CeilingDBTP; meter.TruePeakDBTP > ceiling+0.1 {
				t.Errorf("%.0f Hz %s: live TP meter %.3f dBTP over ceiling %.1f", rate, name, meter.TruePeakDBTP, ceiling)
			}
		}
	}
}

// An applied Deep script plays live through the schedule bridge on the
// export algorithm (src/lib/engine-params.ts exportScript) and must equal the
// script export render once the worklet's read-ahead compensates the latency.
func TestLiveDeepScriptRendersTheExport(t *testing.T) {
	const rate = 48000
	ctx := context.Background()
	seconds := 8
	if raceEnabled {
		seconds = 3 // the full 8 s runs in CI's non-race step
	}
	left, right := denseMix(rate, seconds)
	buf := &audio.Buffer{SampleRate: rate, Channels: 2, Frames: len(left), Duration: float64(len(left)) / rate, Left: left, Right: right}
	script, _, err := mastering.AnalyzeDeepV2Context(ctx, buf, mastering.ProfilePunchyCommercial, nil)
	if err != nil {
		t.Fatal(err)
	}
	script.ChainParams.AlgorithmVersion, script.ChainParams.Limiter.TruePeak, script.ChainParams.DitherBits = dsp.TruePeakAlgorithmVersion, true, 0
	script.ChainParams.Limiter.Enabled, script.ChainParams.Limiter.CeilingDBTP = true, -1
	// Drive the limiter and widen across the first section so the schedule
	// moves into and out of heavy true-peak limiting.
	if len(script.Sections) == 0 {
		t.Fatal("analysis returned no sections")
	}
	section := script.Sections[0]
	first, last := section.StartFrame, section.EndFrame-1
	middle := first + (last-first)/2
	script.Moves = append(script.Moves,
		automation.Move{ID: "lift", SectionID: section.ID, Reason: "V1-10 parity", Target: "inputGainDb", Operation: "absolute", Points: []automation.Point{{Frame: first, Value: 0}, {Frame: middle, Value: 8}, {Frame: last, Value: 2}}},
		automation.Move{ID: "spread", SectionID: section.ID, Reason: "V1-10 parity", Target: "stereo.widthPct", Operation: "absolute", Points: []automation.Point{{Frame: first, Value: 100}, {Frame: last, Value: 160}}},
	)
	exportL, exportR, exported, err := mastering.RenderScriptV2Context(ctx, buf, script)
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := mastering.ValidateScriptV2Context(ctx, script, rate)
	if err != nil {
		t.Fatal(err)
	}
	source := sourceBinding{rate: rate, frames: int64(len(left)), hash: [8]uint32{1, 2, 3, 4, 5, 6, 7, 8}}
	bridge := NewBridge(rate)
	if !bridge.bindSource(source) {
		t.Fatal("bind failed")
	}
	install(t, bridge, source, script.ChainParams, schedule, 1)
	latency := bridge.LatencyFrames()
	if latency == 0 {
		t.Fatal("applied script is not on the export algorithm")
	}
	var inL, inR, outL, outR [liveBlockFrames]float32
	heard := [2][]float32{}
	for start := 0; len(heard[0]) < len(left)+latency; start += liveBlockFrames {
		for i := range inL {
			inL[i], inR[i] = 0, 0
			if start+i < len(left) {
				inL[i], inR[i] = left[start+i], right[start+i]
			}
		}
		if !bridge.ProcessBlock(inL[:], inR[:], outL[:], outR[:]) {
			t.Fatal("schedule quantum rejected")
		}
		heard[0], heard[1] = append(heard[0], outL[:]...), append(heard[1], outR[:]...)
	}
	heard[0], heard[1] = heard[0][latency:latency+len(left)], heard[1][latency:latency+len(left)]
	residual := residualDB(heard, [2][]float32{exportL, exportR})
	deltaLUFS := dsp.MeasureStereo(heard[0], heard[1], rate).IntegratedLUFS - exported.IntegratedLUFS
	t.Logf("applied script: residual %.1f dB, LUFS delta %.4f, %d moves", residual, deltaLUFS, len(schedule.NumericMoves()))
	if residual > -60 || math.Abs(deltaLUFS) > 0.1 {
		t.Fatalf("live script vs export: residual %.1f dB, LUFS delta %.3f", residual, deltaLUFS)
	}
}

func TestLiveVectorRoundTrips(t *testing.T) {
	params := heaviestLiveParams(dsp.TruePeakAlgorithmVersion, dsp.SatTransformer)
	vector := liveVector(params)
	var legacy liveControlVector
	copy(legacy[:], vector[:liveControlValues])
	decoded, accepted := legacy.params()
	decoded.AlgorithmVersion = uint32(vector[liveControlValues])
	if !accepted || decoded != params {
		t.Fatalf("vector does not round-trip: %+v", decoded)
	}
}

// loudAbruptEnd is the V1-13 Round E probe: a hard-clipped ±0.9 square and a
// 0.449 fs tone that stop at full level on the last frame.
func loudAbruptEnd(rate float64, frames int) ([]float32, []float32) {
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		square := 0.9
		if math.Sin(2*math.Pi*441*float64(i)/rate) < 0 {
			square = -0.9
		}
		tone := 0.3 * math.Sin(2*math.Pi*0.449*float64(i))
		left[i] = float32(math.Max(-0.9, math.Min(0.9, square+tone)))
		right[i] = float32(math.Max(-0.9, math.Min(0.9, 0.8*square-tone)))
	}
	return left, right
}

// V1-13 Round E R2: a file that ends loud renders the same final frames live
// as exported. The export drains the lookahead against silence (dsp.Engine
// Drain clears the Nyquist guard), so live playback must drain from the
// source's last frame too, not run the chain and guard on into silence.
func TestLivePlaybackOfALoudAbruptEndRendersTheExport(t *testing.T) {
	p := dsp.DefaultParams()
	p.AlgorithmVersion, p.InputGainDB = dsp.TruePeakAlgorithmVersion, 4
	p.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -9, ReleaseMS: 80, TruePeak: true}
	every := heaviestLiveParams(dsp.TruePeakAlgorithmVersion, dsp.SatTube)
	for _, rate := range []float64{44100, 48000} {
		// An end inside a quantum and one on its boundary.
		for _, frames := range []int{int(rate/4) + 37, 128 * 90} {
			left, right := loudAbruptEnd(rate, frames)
			for name, params := range map[string]dsp.Params{"limiter": p, "every module on": every} {
				heardL, heardR, _ := livePlayback(t, rate, left, right, params)
				exportL, exportR, _ := dsp.RenderBuffer(left, right, rate, params)
				if residual := residualDB([2][]float32{heardL, heardR}, [2][]float32{exportL, exportR}); !math.IsInf(residual, -1) {
					t.Errorf("%.0f Hz, %d frames, %s: live vs export residual %.1f dB, want bit-identical", rate, frames, name, residual)
				}
			}
		}
	}
}
