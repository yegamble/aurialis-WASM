package mastering

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func constantSignal() *audio.Buffer {
	const frames = 8000
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		left[i] = 0.05
		right[i] = 0.05
	}
	return &audio.Buffer{SampleRate: 8000, Channels: 2, Frames: frames, Duration: 1, Left: left, Right: right}
}

func neutralChain() dsp.Params {
	p := dsp.DefaultParams()
	p.Compressor.Enabled = false
	p.EQEnabled = false
	p.Saturation.Enabled = false
	p.Stereo.Enabled = false
	p.Repair.Enabled = false
	p.Limiter.Enabled = false
	return p
}

func TestVolumeEnvelopeUsesPointsAtExactTimeWithoutCompression(t *testing.T) {
	base := neutralChain()
	move := Move{ID: "fader", Lane: "volume", StartSec: 0.1, EndSec: 0.9, Value: 30, Points: [][2]float64{{0.1, 0}, {0.5, 6}, {0.9, 0}}}
	script := &Script{ChainParams: base, Moves: []Move{move}}
	left, right, _, err := RenderScriptContext(context.Background(), constantSignal(), script)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		frame  int
		gainDB float64
	}{{400, 0}, {2400, 3}, {4000, 6}, {5600, 3}, {7600, 0}} {
		want := 0.05 * math.Pow(10, test.gainDB/20)
		if math.Abs(float64(left[test.frame])-want) > 1e-6 || left[test.frame] != right[test.frame] {
			t.Fatalf("frame%d actual=%g want=%g", test.frame, left[test.frame], want)
		}
	}
	params := applyMovesAtTime(base, script.Moves, 0.5)
	if params.Compressor != base.Compressor || params.Limiter != base.Limiter || params.Stereo != base.Stereo || params.Saturation != base.Saturation {
		t.Fatal("volume automation changed another stage")
	}
	if params.InputGainDB != 6 {
		t.Fatalf("input gain=%g want6", params.InputGainDB)
	}
}

func TestMoveScalarFallbackMuteAndBoundaryContinuity(t *testing.T) {
	move := Move{ID: "fader", Lane: "volume", StartSec: 0.2, EndSec: 0.8, Value: 6}
	script := &Script{ChainParams: neutralChain(), Moves: []Move{move}}
	left, _, _, err := RenderScriptContext(context.Background(), constantSignal(), script)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(float64(left[4000])-0.05*math.Pow(10, 6.0/20)) > 1e-6 {
		t.Fatal("scalar fallback did not apply6dB")
	}
	for _, frame := range []int{1600, 6400} {
		if math.Abs(float64(left[frame]-left[frame-1])) > 0.0005 || math.Abs(float64(left[frame+1]-left[frame])) > 0.0005 {
			t.Fatalf("gain step atframe%d", frame)
		}
	}
	script.Moves[0].Muted = true
	muted, _, _, err := RenderScriptContext(context.Background(), constantSignal(), script)
	if err != nil {
		t.Fatal(err)
	}
	for i, sample := range muted {
		if sample != 0.05 {
			t.Fatalf("muted envelope changed frame%d", i)
		}
	}
}

func TestScriptTargetDoesNotChangeExplicitGain(t *testing.T) {
	buf := constantSignal()
	base := neutralChain()
	base.Limiter.Enabled = true
	script := &Script{ChainParams: base, TargetLUFS: -8, BeforeMetrics: dsp.Metrics{IntegratedLUFS: -40}}
	first, _, _, err := RenderScriptContext(context.Background(), buf, script)
	if err != nil {
		t.Fatal(err)
	}
	script.TargetLUFS = -28
	script.BeforeMetrics.IntegratedLUFS = -8
	second, _, _, err := RenderScriptContext(context.Background(), buf, script)
	if err != nil {
		t.Fatal(err)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("metadata changed sample%d", i)
		}
	}
}

func TestInvalidAndCanceledScriptsFailExplicitly(t *testing.T) {
	buf := constantSignal()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := RenderScriptContext(ctx, buf, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelerr=%v", err)
	}
	base := neutralChain()
	for _, move := range []Move{
		{ID: "unknown", Lane: "mystery", StartSec: 0, EndSec: 1},
		{Lane: "volume", StartSec: 0, EndSec: 1, Points: [][2]float64{{0.5, 1}, {0.4, 2}}},
		{Lane: "volume", StartSec: 0, EndSec: 1, Points: [][2]float64{{0, 1}, {1, math.Inf(1)}}},
		{Lane: "volume", StartSec: 1, EndSec: 0, Value: 1},
	} {
		if _, _, _, err := RenderScriptContext(context.Background(), buf, &Script{ChainParams: base, Moves: []Move{move}}); err == nil {
			t.Fatal("invalid script accepted")
		}
	}
	buf.Right = nil
	if _, err := AnalyzeDeep(context.Background(), buf, ProfileWarmAnalog, nil); err == nil {
		t.Fatal("invalid stereo buffer accepted")
	}
}
