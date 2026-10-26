package steminfer

// cspell:words steminfer linspace stemyla demix

import (
	"context"
	"errors"
)

// chunkAssembler follows the MIT stemyla/original demix_track border, tail and
// linear-fade conventions (see LICENSE/NOTICE). It keeps at most one chunk of
// sums regardless of song length. The caller supplies model-rate samples and
// receives borrowed, contiguous model-rate output; it must inverse-resample
// that continuous output rather than independently resampling each chunk.
type chunkAssembler struct {
	length, chunk, step, border, fade, total, position, base int
	padded                                                   bool
	heads                                                    int
	window, counter, left, right                             []float32
	sums                                                     [5][2][]float32
	accepted                                                 [5]bool
}

func newChunkAssembler(length, chunk, heads int) (*chunkAssembler, error) {
	if length < 1 || length > maximumSourceFrames || chunk < 20 || chunk > maximumWindowSamples || chunk%2 != 0 || heads < 1 || heads > 5 {
		return nil, errors.New("invalid bounded chunk assembly")
	}
	work := &chunkAssembler{length: length, chunk: chunk, step: chunk / 2, border: chunk / 2, fade: chunk / 10, heads: heads}
	work.padded = length > 2*work.border
	work.total = length
	if work.padded {
		work.total += 2 * work.border
	}
	work.window = make([]float32, chunk)
	work.counter = make([]float32, chunk)
	work.left = make([]float32, chunk)
	work.right = make([]float32, chunk)
	for i := range work.window {
		work.window[i] = 1
	}
	for i := range work.fade {
		// torch.linspace computes opposite halves from their nearest endpoint.
		step := float32(1) / float32(work.fade-1)
		in, out := step*float32(i), 1-step*float32(i)
		if i >= work.fade/2 {
			in = 1 - step*float32(work.fade-1-i)
			out = step * float32(work.fade-1-i)
		}
		work.window[i] *= in
		work.window[chunk-work.fade+i] *= out
	}
	for head := range heads {
		for channel := range 2 {
			work.sums[head][channel] = make([]float32, chunk)
		}
	}
	return work, nil
}
func (work *chunkAssembler) sourceIndex(index int) int {
	if work.padded {
		index -= work.border
		return repeatedReflection(index, work.length)
	}
	return index
}
func (work *chunkAssembler) input(ctx context.Context, sample func(channel, index int) float32) ([]float32, []float32, error) {
	if ctx == nil || sample == nil || work.position >= work.total {
		return nil, nil, errors.New("no bounded chunk input")
	}
	length := min(work.chunk, work.total-work.position)
	clear(work.left)
	clear(work.right)
	for channel, destination := range [2][]float32{work.left, work.right} {
		for i := range length {
			if i%4096 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, nil, err
				}
			}
			destination[i] = sample(channel, work.sourceIndex(work.position+i))
			if !finite32(destination[i]) {
				return nil, nil, errors.New("non-finite chunk source")
			}
		}
		if length < work.chunk && length > work.chunk/2+1 {
			for i := length; i < work.chunk; i++ {
				destination[i] = destination[2*(length-1)-i]
			}
		}
	}
	return work.left, work.right, nil
}
func (work *chunkAssembler) weight(index int) float32 {
	if work.position == 0 && index < work.fade {
		return 1
	}
	if work.position != 0 && work.position+work.chunk >= work.total && index >= work.chunk-work.fade {
		return 1
	}
	return work.window[index]
}
func (work *chunkAssembler) accept(ctx context.Context, head int, left, right []float32) error {
	length := min(work.chunk, work.total-work.position)
	if ctx == nil || work.position >= work.total || head < 0 || head >= work.heads || work.accepted[head] || len(left) < length || len(right) < length {
		return errors.New("invalid chunk output")
	}
	for channel, source := range [2][]float32{left, right} {
		destination := work.sums[head][channel]
		for i := range length {
			if i%4096 == 0 {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
			if !finite32(source[i]) {
				return errors.New("non-finite trained chunk output")
			}
			index := (work.position + i) % work.chunk
			destination[index] += source[i] * work.weight(i)
			if !finite32(destination[index]) {
				return errors.New("chunk accumulation exceeds finite range")
			}
		}
	}
	work.accepted[head] = true
	return nil
}
func (work *chunkAssembler) advance(ctx context.Context, consume func(head, start int, left, right []float32) error) error {
	if ctx == nil || consume == nil || work.position >= work.total {
		return errors.New("invalid chunk advancement")
	}
	for head := range work.heads {
		if !work.accepted[head] {
			return errors.New("incomplete trained chunk head set")
		}
	}
	length := min(work.chunk, work.total-work.position)
	for i := range length {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		work.counter[(work.position+i)%work.chunk] += work.weight(i)
	}
	work.position += work.step
	ready := min(work.position, work.total)
	from, to := 0, work.length
	if work.padded {
		from = work.border
		to = work.total - work.border
	}
	low, high := max(work.base, from), min(ready, to)
	count := max(0, high-low)
	for head := range work.heads {
		for channel, destination := range [2][]float32{work.left, work.right} {
			source := work.sums[head][channel]
			for i := range count {
				if i%4096 == 0 {
					if err := ctx.Err(); err != nil {
						return err
					}
				}
				index := (low + i) % work.chunk
				if work.counter[index] <= 0 {
					return errors.New("uncovered overlap output")
				}
				destination[i] = source[index] / work.counter[index]
				if !finite32(destination[i]) {
					return errors.New("non-finite overlap output")
				}
			}
		}
		if count > 0 {
			if err := consume(head, low-from, work.left[:count], work.right[:count]); err != nil {
				return err
			}
		}
	}
	for i := work.base; i < ready; i++ {
		index := i % work.chunk
		work.counter[index] = 0
		for head := range work.heads {
			work.sums[head][0][index] = 0
			work.sums[head][1][index] = 0
		}
	}
	work.base = ready
	clear(work.accepted[:])
	return ctx.Err()
}
