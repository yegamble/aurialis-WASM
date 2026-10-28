package main

import (
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// denseMix is a deterministic 12 s kick, snare, hat and bass loop peaking at
// −1.3 dBFS, like e2e/workflow-fixture.ts denseFixture.
func denseMix(rate float64, seconds int) ([]float32, []float32) {
	frames := int(rate) * seconds
	left, right := make([]float64, frames), make([]float64, frames)
	seed := uint32(0x9e3779b9)
	noise := func() float64 {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		return float64(seed)/2147483648 - 1
	}
	beatFrames, eighthFrames := int(rate/2), int(rate/4)
	kickPhase, lastL, lastR, peak := 0.0, 0.0, 0.0, 0.0
	for i := range left {
		beat, inBeat, inEighth := i/beatFrames, float64(i%beatFrames), float64(i%eighthFrames)
		kickPhase += 2 * math.Pi * (48 + 110*math.Exp(-inBeat/480)) / rate
		kick := 0.9*math.Sin(kickPhase)*math.Exp(-inBeat/7200) + 0.25*noise()*math.Exp(-inBeat/96)
		snare := 0.0
		if beat%2 == 1 {
			snare = 0.55*noise()*math.Exp(-inBeat/2400) + 0.3*math.Sin(2*math.Pi*185*inBeat/rate)*math.Exp(-inBeat/1400)
		}
		hatL, hatR := noise(), noise()
		hat := 0.4 * math.Exp(-inEighth/720)
		at := float64(i) / rate
		bass := (0.5*math.Sin(2*math.Pi*55*at) + 0.2*math.Sin(2*math.Pi*110*at) + 0.1*math.Sin(2*math.Pi*165*at)) * (0.95 + 0.15*math.Exp(-inBeat/9600))
		left[i] = kick + snare + (hatL-lastL)*hat + bass
		right[i] = kick + 0.9*snare + (hatR-lastR)*hat + bass
		lastL, lastR = hatL, hatR
		peak = math.Max(peak, math.Max(math.Abs(left[i]), math.Abs(right[i])))
	}
	scale := math.Pow(10, -1.3/20) / peak
	outL, outR := make([]float32, frames), make([]float32, frames)
	for i := range left {
		outL[i], outR[i] = float32(left[i]*scale), float32(right[i]*scale)
	}
	return outL, outR
}

// V1-11 Round E REQUIRED-1: the match must be measured on what the worklet
// plays. The UI measures the live settings with an offline render and applies
// the attenuate-only offset after the streaming engine. Since V1-10 the live
// settings are the export settings (algorithm 2), so with heavy limiting the
// heard A and B must agree within ±0.5 LU after the match.
func TestMatchedABHoldsOnHeavilyLimitedLivePlayback(t *testing.T) {
	const rate = 48000.0
	left, right := denseMix(rate, 12)
	source := dsp.MeasureStereo(left, right, rate)
	for _, drive := range []float64{12, 15, 18} {
		live := dsp.DefaultParams()
		live.AlgorithmVersion, live.InputGainDB = dsp.TruePeakAlgorithmVersion, drive
		live.Limiter = dsp.LimiterParams{Enabled: true, CeilingDBTP: -1, TargetLUFS: -14, ReleaseMS: 80, TruePeak: true}

		// Heard A: the worklet's ABI, quanta and latency compensation.
		heardL, heardR, _ := livePlayback(t, rate, left, right, live)
		heard := dsp.MeasureStereo(heardL, heardR, rate)

		// What measureRender returns for the live settings: the offline render.
		_, _, measured := dsp.RenderBuffer(left, right, rate, live)
		processedDB, originalDB := matchOffsets(measured.IntegratedLUFS, source.IntegratedLUFS)
		if processedDB > 0 || originalDB > 0 {
			t.Fatal("the match boosted a side")
		}
		matchedError := (heard.IntegratedLUFS + processedDB) - (source.IntegratedLUFS + originalDB)
		if math.Abs(matchedError) > 0.5 {
			t.Fatalf("+%.0f dB drive: heard A − B %.2f LU after the match", drive, matchedError)
		}
		t.Logf("+%.0f dB drive: heard A − B %.4f LU after the match (offset %.2f dB)", drive, matchedError, math.Min(processedDB, originalDB))
	}
}

// matchOffsets mirrors src/lib/loudness-match.ts matchGains: lower only the louder side.
func matchOffsets(processedLUFS, originalLUFS float64) (processedDB, originalDB float64) {
	difference := processedLUFS - originalLUFS
	if difference > 0 {
		return -difference, 0
	}
	return 0, difference
}
