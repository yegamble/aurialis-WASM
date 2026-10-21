package mastering

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

const moveFadeSeconds = 0.01

// RenderScriptContext applies sample-timed moves to the explicit baseline chain.
// Points, when present, are authoritative linear envelopes; Value is the fallback
// for moves without points. Ten millisecond boundary fades avoid step changes.
// Loudness targets are metadata and never introduce an implicit gain adjustment.
func RenderScriptContext(ctx context.Context, buf *audio.Buffer, script *Script) ([]float32, []float32, dsp.Metrics, error) {
	if err := validateStereoBuffer(ctx, buf); err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	if script == nil {
		return dsp.RenderBufferContext(ctx, buf.Left, buf.Right, float64(buf.SampleRate), dsp.DefaultParams())
	}
	if err := validateScript(script); err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	n := len(buf.Left)
	left, right := make([]float32, n), make([]float32, n)
	sampleRate := float64(buf.SampleRate)
	engine := dsp.NewEngine(sampleRate)
	current := script.ChainParams
	engine.SetParams(current)
	start := 0
	for frame := 0; frame < n; frame++ {
		if frame%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, dsp.Metrics{}, err
			}
		}
		params := applyMovesAtTime(script.ChainParams, script.Moves, float64(frame)/sampleRate)
		if params == current && frame-start < 4096 {
			continue
		}
		if frame > start {
			engine.ProcessBlock(buf.Left[start:frame], buf.Right[start:frame], left[start:frame], right[start:frame])
		}
		if params != current {
			if err := dsp.ValidateParams(params); err != nil {
				return nil, nil, dsp.Metrics{}, fmt.Errorf("invalid combined automation: %w", err)
			}
			engine.SetParams(params)
			current = params
		}
		start = frame
	}
	engine.ProcessBlock(buf.Left[start:], buf.Right[start:], left[start:], right[start:])
	if err := ctx.Err(); err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	metrics, measureErr := dsp.MeasureStereoContext(ctx, left, right, sampleRate)
	if measureErr != nil {
		return nil, nil, dsp.Metrics{}, measureErr
	}
	metrics.GainReductionDB = engine.LastGainReductionDB()
	if err := ctx.Err(); err != nil {
		return nil, nil, dsp.Metrics{}, err
	}
	return left, right, metrics, nil
}

func validateStereoBuffer(ctx context.Context, buf *audio.Buffer) error {
	if ctx == nil {
		return errors.New("context is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if buf == nil || len(buf.Left) == 0 {
		return audio.ErrEmptyAudio
	}
	if len(buf.Left) != len(buf.Right) || len(buf.Left) > audio.MaxDecodedFrames || buf.SampleRate < 8000 || buf.SampleRate > 192000 {
		return errors.New("unsupported stereo buffer layout or sample rate")
	}
	for i := range buf.Left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if !isFinite(float64(buf.Left[i])) || !isFinite(float64(buf.Right[i])) {
			return errors.New("non-finite PCM sample")
		}
	}
	return nil
}

func validateScript(script *Script) error {
	if err := dsp.ValidateParams(script.ChainParams); err != nil {
		return err
	}
	if len(script.Moves) > 128 {
		return errors.New("script exceeds 128 automation moves")
	}
	for _, move := range script.Moves {
		low, high, ok := moveRange(move)
		if !ok {
			return fmt.Errorf("unsupported automation move %q", move.ID)
		}
		if !isFinite(move.StartSec) || !isFinite(move.EndSec) || move.StartSec < 0 || move.EndSec <= move.StartSec || !isFinite(move.Value) || move.Value < low || move.Value > high {
			return errors.New("invalid automation time or value")
		}
		if len(move.Points) > 256 {
			return errors.New("move exceeds 256 envelope points")
		}
		for i, point := range move.Points {
			if !isFinite(point[0]) || !isFinite(point[1]) || point[0] < move.StartSec || point[0] > move.EndSec || point[1] < low || point[1] > high || (i > 0 && point[0] <= move.Points[i-1][0]) {
				return errors.New("invalid automation envelope point")
			}
		}
	}
	return nil
}

func moveRange(move Move) (float64, float64, bool) {
	switch move.ID {
	case "move-eq-sub", "move-eq-presence", "move-eq-air", "move-repair-transient":
		return -24, 24, true
	case "move-compsat-verse":
		return 1, 100, true
	case "move-compsat-chorus":
		return 0, 100, true
	case "move-repair-deess":
		return 0, 24, true
	}
	switch strings.ToLower(move.Lane) {
	case "volume":
		return -36, 36, true
	case "width":
		return 0, 200, true
	default:
		return 0, 0, false
	}
}

func envelopeAt(move *Move, tSec float64) float64 {
	if len(move.Points) == 0 {
		return move.Value
	}
	index := sort.Search(len(move.Points), func(i int) bool { return move.Points[i][0] >= tSec })
	if index == 0 {
		return move.Points[0][1]
	}
	if index == len(move.Points) {
		return move.Points[index-1][1]
	}
	left, right := move.Points[index-1], move.Points[index]
	position := (tSec - left[0]) / (right[0] - left[0])
	return left[1] + (right[1]-left[1])*position
}

func applyMovesAtTime(base dsp.Params, moves []Move, tSec float64) dsp.Params {
	params := base
	for i := range moves {
		move := &moves[i]
		if move.Muted || tSec <= move.StartSec || tSec >= move.EndSec {
			continue
		}
		fade := math.Min(moveFadeSeconds, (move.EndSec-move.StartSec)/2)
		weight := math.Min(1, math.Min((tSec-move.StartSec)/fade, (move.EndSec-tSec)/fade))
		value := envelopeAt(move, tSec)
		blend := func(original float64) float64 { return original + (value-original)*weight }
		switch move.ID {
		case "move-eq-sub":
			params.Bands[0].GainDB = blend(params.Bands[0].GainDB)
		case "move-eq-presence":
			params.Bands[3].GainDB = blend(params.Bands[3].GainDB)
		case "move-eq-air":
			params.Bands[4].GainDB = blend(params.Bands[4].GainDB)
		case "move-compsat-verse":
			params.Compressor.Ratio = blend(params.Compressor.Ratio)
		case "move-compsat-chorus":
			params.Saturation.Amount = blend(params.Saturation.Amount)
		case "move-repair-deess":
			params.Repair.Enabled = true
			params.Repair.DeEssDB = blend(params.Repair.DeEssDB)
		case "move-repair-transient":
			params.Repair.Enabled = true
			params.Repair.TransientDB = blend(params.Repair.TransientDB)
		default:
			switch strings.ToLower(move.Lane) {
			case "volume":
				params.InputGainDB += value * weight
			case "width":
				params.Stereo.WidthPct = blend(params.Stereo.WidthPct)
			}
		}
	}
	return params
}

func isFinite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
