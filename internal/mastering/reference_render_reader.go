package mastering

import (
	"context"
	"errors"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// referenceRenderReader exposes exactly the source-length export stream while
// retaining only fixed scratch. Input latency is discarded; the actual Drain
// supplies the final source frames, including sources shorter than the latency.
type referenceRenderReader struct {
	source                     *audio.Buffer
	engine                     *dsp.Engine
	input, skip, cursor, count int
	left, right                [4096]float32
}

func newReferenceRenderReader(source *audio.Buffer, engine *dsp.Engine) (*referenceRenderReader, error) {
	latency := engine.LatencyFrames()
	if latency < 0 || latency > 4096 {
		return nil, errors.New("reference render latency exceeds its bounded scratch")
	}
	return &referenceRenderReader{source: source, engine: engine, skip: latency}, nil
}

func (r *referenceRenderReader) read(ctx context.Context, left, right []float32) error {
	for written := 0; written < len(left); {
		if err := ctx.Err(); err != nil {
			return err
		}
		if r.cursor == r.count {
			r.cursor = 0
			if r.input < len(r.source.Left) {
				r.count = min(len(r.left), len(r.source.Left)-r.input)
				end := r.input + r.count
				r.engine.ProcessBlock(r.source.Left[r.input:end], r.source.Right[r.input:end], r.left[:r.count], r.right[:r.count])
				r.input = end
			} else {
				r.count = r.engine.Drain(r.left[:], r.right[:])
			}
			if r.count == 0 {
				return errors.New("reference render ended before its source-length output")
			}
			discard := min(r.skip, r.count)
			r.skip -= discard
			r.cursor = discard
		}
		count := min(len(left)-written, r.count-r.cursor)
		copy(left[written:written+count], r.left[r.cursor:r.cursor+count])
		copy(right[written:written+count], r.right[r.cursor:r.cursor+count])
		r.cursor += count
		written += count
	}
	return nil
}
