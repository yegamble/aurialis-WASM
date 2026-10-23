package steminfer

// cspell:words softmax steminfer GELU

import (
	"context"
	"errors"
)

const attentionTile = 32
const nonlinearTile = 65536

func attentionSoftmax(ctx context.Context, values []float32, rows, width int) error {
	if ctx == nil || rows < 1 || rows > attentionTile || width < 1 || width > maximumSequence || len(values) != rows*width {
		return errors.New("invalid bounded attention tile")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Each query still attends to every key in the complete model window. Tiling
	// bounds storage/cancellation latency; it does not truncate time context.
	softmaxBackend(values, rows, width)
	return ctx.Err()
}

func applyGELU(ctx context.Context, values []float32) error {
	if ctx == nil {
		return errors.New("nil inference context")
	}
	for first := 0; first < len(values); first += nonlinearTile {
		if err := ctx.Err(); err != nil {
			return err
		}
		geluBackend(values[first:min(first+nonlinearTile, len(values))])
	}
	return ctx.Err()
}
func applyTanh(ctx context.Context, values []float32) error {
	if ctx == nil {
		return errors.New("nil inference context")
	}
	for first := 0; first < len(values); first += nonlinearTile {
		if err := ctx.Err(); err != nil {
			return err
		}
		tanhBackend(values[first:min(first+nonlinearTile, len(values))])
	}
	return ctx.Err()
}
