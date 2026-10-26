package browserjobs_test

import (
	"encoding/json"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
)

// denseProgram mirrors denseFixture in e2e/workflow-fixture.ts: a deterministic
// 120 BPM drum-and-bass loop (pitched kick + click, noise snare, stereo noise
// hats, harmonic bass) scaled to a -1.3 dBFS sample peak. Unlike a pure tone it
// has full-band transients whose inter-sample peaks overshoot a sample-peak
// limiter, which is what made Set target loudness reject ordinary mixes.
func denseProgram(seconds int) (left, right []float32) {
	const rate = 48000
	frames := rate * seconds
	left, right = make([]float32, frames), make([]float32, frames)
	seed := uint32(0x9e3779b9)
	noise := func() float64 {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		return float64(seed)/2147483648 - 1
	}
	var kickPhase, lastHatL, lastHatR, peak float64
	for i := range frames {
		beat, inBeat := i/24000, float64(i%24000)
		inEighth := float64(i % 12000)
		kickFrequency := 48 + 110*math.Exp(-inBeat/480)
		kickPhase += 2 * math.Pi * kickFrequency / rate
		kick := 0.9*math.Sin(kickPhase)*math.Exp(-inBeat/7200) + 0.25*noise()*math.Exp(-inBeat/96)
		snare := 0.0
		if beat%2 == 1 {
			snare = 0.55*noise()*math.Exp(-inBeat/2400) + 0.3*math.Sin(2*math.Pi*185*inBeat/rate)*math.Exp(-inBeat/1400)
		}
		hatEnvelope := 0.4 * math.Exp(-inEighth/720)
		hatL, hatR := noise(), noise()
		hatOutL, hatOutR := (hatL-lastHatL)*hatEnvelope, (hatR-lastHatR)*hatEnvelope
		lastHatL, lastHatR = hatL, hatR
		at := float64(i) / rate
		bass := (0.5*math.Sin(2*math.Pi*55*at) + 0.2*math.Sin(2*math.Pi*110*at) + 0.1*math.Sin(2*math.Pi*165*at)) * (0.95 + 0.15*math.Exp(-inBeat/9600))
		l := kick + snare + 0.8*hatOutL + 0.3*hatOutR + bass
		r := kick + 0.9*snare + 0.3*hatOutL + 0.8*hatOutR + bass
		left[i], right[i] = float32(l), float32(r)
		peak = math.Max(peak, math.Max(math.Abs(l), math.Abs(r)))
	}
	scale := math.Pow(10, -1.3/20) / peak
	for i := range left {
		left[i] = float32(float64(left[i]) * scale)
		right[i] = float32(float64(right[i]) * scale)
	}
	return left, right
}

func denseWAV(t *testing.T) []byte {
	t.Helper()
	left, right := denseProgram(8)
	wav, err := audio.EncodeWAV(left, right, 48000, 16)
	if err != nil {
		t.Fatal(err)
	}
	return wav
}

type renderMetrics struct {
	AfterMetrics dsp.Metrics `json:"afterMetrics"`
}

// measure is the browser's measureAudio: render format=json with the given params.
func measure(t *testing.T, wav []byte, params dsp.Params) dsp.Metrics {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	result := run(t, browserjobs.Request{Operation: "render", Params: string(encoded), Format: "json"}, wav, nil)
	var body renderMetrics
	if err := json.Unmarshal(result.Metadata, &body); err != nil {
		t.Fatal(err)
	}
	return body.AfterMetrics
}

var errPeakCeiling = errors.New("loudness target exceeds the measured peak ceiling")

// normalizeLikeBrowser mirrors normalizeSimpleAudio in src/lib/browser-engine.ts:
// the same tolerance, attempt bound, secant/bracket search and peak gate
// (ceiling + EXPORT_PEAK_TOLERANCE_DB), with the export params it measures.
func normalizeLikeBrowser(t *testing.T, wav []byte, params dsp.Params, target float64) (dsp.Params, dsp.Metrics, error) {
	t.Helper()
	lower, upper := -36.0, 36.0
	var previous *[2]float64
	for range 8 {
		after := measure(t, wav, params)
		difference := target - after.IntegratedLUFS
		if math.Abs(difference) <= 0.2 {
			if after.TruePeakDBTP > params.Limiter.CeilingDBTP+0.05 {
				return params, after, errPeakCeiling
			}
			return params, after, nil
		}
		if difference > 0 {
			lower = math.Max(lower, params.InputGainDB)
		} else {
			upper = math.Min(upper, params.InputGainDB)
		}
		next := params.InputGainDB + difference
		if previous != nil {
			slope := (after.IntegratedLUFS - previous[1]) / (params.InputGainDB - previous[0])
			if !math.IsNaN(slope) && !math.IsInf(slope, 0) && slope > 0.01 {
				next = params.InputGainDB + difference/slope
			} else {
				next = (lower + upper) / 2
			}
			if next <= lower || next >= upper {
				next = (lower + upper) / 2
			}
		}
		next = math.Max(-36, math.Min(36, next))
		if math.Abs(next-params.InputGainDB) < 0.001 {
			break
		}
		previous = &[2]float64{params.InputGainDB, after.IntegratedLUFS}
		params.InputGainDB = next
	}
	return params, dsp.Metrics{}, errors.New("loudness target could not be reached")
}

// simplePopClean mirrors exportParams(mapSimpleToDSP("Pop", "Clean", 50, target)):
// algorithm 2 with the true-peak limiter.
func simplePopClean(target, ceiling float64) dsp.Params {
	params := dsp.DefaultParams()
	gains := [dsp.NumEQBands]float64{0.1, -0.15, 0, 0.1, 0.25}
	for band := range params.Bands {
		params.Bands[band].GainDB = gains[band]
	}
	params.Bands[1].Q = 0.7
	params.Compressor = dsp.CompressorParams{Enabled: true, ThresholdDB: -11, Ratio: 1.25, AttackMS: 30, ReleaseMS: 200, KneeDB: 6, AutoRelease: true, SidechainHPFHz: 90, Topology: dsp.CompOptical}
	params.Saturation.Enabled = false
	params.Stereo.WidthPct = 102
	params.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: ceiling, TargetLUFS: target, ReleaseMS: 85, TruePeak: true}
	params.AlgorithmVersion = dsp.TruePeakAlgorithmVersion
	return params
}

func TestNormalizeDenseProgramReachesTarget(t *testing.T) {
	wav := denseWAV(t)
	bypass := dsp.DefaultParams()
	bypass.Bypass = true
	source := measure(t, wav, bypass)
	t.Logf("dense source: %.2f LUFS, %.2f dBTP", source.IntegratedLUFS, source.TruePeakDBTP)
	if source.IntegratedLUFS < -17.5 || source.IntegratedLUFS > -14.5 || source.TruePeakDBTP < -1.2 || source.TruePeakDBTP > -0.3 {
		t.Fatalf("dense fixture drifted from ≈-16 LUFS / ≈-0.8 dBTP: %.2f LUFS, %.2f dBTP", source.IntegratedLUFS, source.TruePeakDBTP)
	}
	for _, c := range []struct {
		name            string
		target, ceiling float64
	}{{"Streaming", -14, -1}, {"Loud", -9, -0.2}} {
		t.Run(c.name, func(t *testing.T) {
			params, measured, err := normalizeLikeBrowser(t, wav, simplePopClean(c.target, c.ceiling), c.target)
			if err != nil {
				t.Fatalf("export-parameter search failed: %v (input %+.2f dB, %.2f LUFS, %.2f dBTP)", err, params.InputGainDB, measured.IntegratedLUFS, measured.TruePeakDBTP)
			}
			encoded, err := json.Marshal(params)
			if err != nil {
				t.Fatal(err)
			}
			exported := run(t, browserjobs.Request{Operation: "render", Params: string(encoded), BitDepth: 24}, wav, nil)
			decoded, err := audio.DecodeAndDisarm("export.wav", exported.Audio)
			if err != nil {
				t.Fatal(err)
			}
			delivered := dsp.MeasureStereo(decoded.Left, decoded.Right, float64(decoded.SampleRate))
			t.Logf("algorithm 2 search: input %+.2f dB; exported 24-bit WAV %.2f LUFS, %.2f dBTP", params.InputGainDB, delivered.IntegratedLUFS, delivered.TruePeakDBTP)
			if math.Abs(delivered.IntegratedLUFS-c.target) > 0.2 {
				t.Fatalf("exported loudness %.2f LUFS misses %.0f LUFS by more than 0.2 LU", delivered.IntegratedLUFS, c.target)
			}
			if delivered.TruePeakDBTP > c.ceiling {
				t.Fatalf("exported true peak %.3f dBTP exceeds the %.1f dBTP ceiling", delivered.TruePeakDBTP, c.ceiling)
			}
		})
	}
}
