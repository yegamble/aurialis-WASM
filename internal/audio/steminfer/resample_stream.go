package steminfer

// cspell:words steminfer resampler

import (
	"context"
	"errors"
)

const outputBlockFrames = 4096

// resampleStream preserves one rational clock over the entire source. Future
// input needed by the centered filter is held until the next push; the last
// push applies the original global reflected boundary, never a chunk edge.
// A failed/canceled stream is discarded along with the owning unpublished job.
type resampleStream struct {
	plan                                      *resamplePlan
	inputFrames, outputFrames, received, next int
	carry                                     [2][]float32
	output                                    [2][]float32
}

func newResampleStream(plan *resamplePlan, inputFrames, outputFrames int) (*resampleStream, error) {
	if plan == nil || inputFrames < 1 || inputFrames > maximumSourceFrames || outputFrames < 1 || outputFrames > maximumSourceFrames {
		return nil, errors.New("invalid bounded continuous converter")
	}
	maximum := (int64(inputFrames)*int64(plan.toRate) + int64(plan.fromRate) - 1) / int64(plan.fromRate)
	if int64(outputFrames) > maximum {
		return nil, errors.New("continuous conversion exceeds duration")
	}
	stream := &resampleStream{plan: plan, inputFrames: inputFrames, outputFrames: outputFrames}
	for channel := range 2 {
		stream.carry[channel] = make([]float32, 0, 2*plan.radius+2)
		stream.output[channel] = make([]float32, outputBlockFrames)
	}
	return stream, nil
}
func (stream *resampleStream) push(ctx context.Context, first int, left, right []float32, consume func(start int, left, right []float32) error) error {
	if ctx == nil || stream == nil || consume == nil || first != stream.received || len(left) < 1 || len(left) != len(right) || len(left) > stream.inputFrames-first {
		return errors.New("invalid continuous source span")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	end := first + len(left)
	final := end == stream.inputFrames
	start, count := stream.next, 0
	for stream.next < stream.outputFrames {
		if count%128 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		center := int(int64(stream.next) * int64(stream.plan.fromRate) / int64(stream.plan.toRate))
		if !final && center+stream.plan.radius >= end {
			break
		}
		for channel, input := range [2][]float32{left, right} {
			value, err := stream.plan.at(stream.next, stream.inputFrames, first, input, stream.carry[channel])
			if err != nil {
				return err
			}
			stream.output[channel][count] = value
		}
		stream.next++
		count++
		if count == outputBlockFrames {
			if err := consume(start, stream.output[0][:count], stream.output[1][:count]); err != nil {
				return err
			}
			start = stream.next
			count = 0
		}
	}
	if count > 0 {
		if err := consume(start, stream.output[0][:count], stream.output[1][:count]); err != nil {
			return err
		}
	}
	for channel, input := range [2][]float32{left, right} {
		previous := stream.carry[channel]
		length := min(cap(previous), end)
		destination := previous[:length]
		for i := range length {
			index := end - length + i
			if index < first {
				destination[i] = previous[index-first+len(previous)]
			} else {
				destination[i] = input[index-first]
			}
		}
		stream.carry[channel] = destination
	}
	stream.received = end
	if final && stream.next != stream.outputFrames {
		return errors.New("continuous output length mismatch")
	}
	return ctx.Err()
}
