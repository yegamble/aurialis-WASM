package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"math"
)

type stemSink func(stem, start int, left, right []float32) error
type pipelineProgress struct{ window, windows, completed, total int }
type windowPredictor func(context.Context, []float32, []float32, []int, func(int, []float32, []float32) error, inferenceHooks) error

// runTrainedSeparation is private and unadvertised. The caller must own immutable
// canonical source PCM and reserve estimatePipeline's requiredJobBytes before
// entering, plus separately reserve the shared immutable model. Partial sink
// writes are unpublished job state and must be discarded after any error.
// No job timeout is configured here; the owner supplies a cancellable context.
func runTrainedSeparation(ctx context.Context, archive *weightArchive, rate, stems int, left, right []float32, admittedBytes int64, sink stemSink, progress func(pipelineProgress)) error {
	resources, err := estimatePipeline(rate, len(left), stems, maximumWindowSamples, defaultWorkers())
	if err != nil {
		return err
	}
	if ctx == nil || len(left) != len(right) || sink == nil || admittedBytes < resources.requiredJobBytes || admittedBytes > maximumPrivateJobBytes {
		return errors.New("private separation has no valid bounded admission")
	}
	if err := validatePipelineSource(ctx, left, right); err != nil {
		return err
	}
	runner, err := newWindowRunner(ctx, archive, maximumWindowSamples, resources.workers)
	if err != nil {
		return err
	}
	return runPipelineCore(ctx, resources, left, right, runner.predict, sink, progress)
}
func validatePipelineSource(ctx context.Context, left, right []float32) error {
	if ctx == nil || len(left) != len(right) {
		return errors.New("invalid private separation source")
	}
	for i := range left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if !finite32(left[i]) || !finite32(right[i]) {
			return errors.New("non-finite private separation source")
		}
	}
	return ctx.Err()
}
func runPipelineCore(ctx context.Context, resources pipelineResources, left, right []float32, predict windowPredictor, sink stemSink, progress func(pipelineProgress)) error {
	canonical, resourceErr := estimatePipeline(resources.sourceRate, resources.sourceFrames, resources.stems, resources.window, resources.workers)
	if resourceErr != nil || canonical != resources {
		return errors.New("private pipeline resource plan changed")
	}
	if ctx == nil || predict == nil || sink == nil || len(left) != resources.sourceFrames || len(right) != len(left) {
		return errors.New("invalid private pipeline source")
	}
	if err := validatePipelineSource(ctx, left, right); err != nil {
		return err
	}
	forward, err := newResamplePlan(ctx, resources.sourceRate, modelSampleRate)
	if err != nil {
		return err
	}
	inverse, err := newResamplePlan(ctx, modelSampleRate, resources.sourceRate)
	if err != nil {
		return err
	}
	assembler, err := newChunkAssembler(resources.modelFrames, resources.window, resources.heads)
	if err != nil {
		return err
	}
	streams := make([]*resampleStream, resources.heads)
	for head := range streams {
		streams[head], err = newResampleStream(inverse, resources.modelFrames, resources.sourceFrames)
		if err != nil {
			return err
		}
	}
	groups := newGroupAccumulator(resources, left, right, sink)
	heads := make([]int, resources.heads)
	for i := range heads {
		heads[i] = i
	}
	windows := (assembler.total + assembler.step - 1) / assembler.step
	windowIndex := 0
	for assembler.position < assembler.total {
		if err := ctx.Err(); err != nil {
			return err
		}
		var sourceError error
		inputLeft, inputRight, err := assembler.input(ctx, func(channel, index int) float32 {
			source := left
			if channel == 1 {
				source = right
			}
			value, sampleErr := forward.at(index, len(source), 0, source, nil)
			if sampleErr != nil {
				sourceError = sampleErr
				return float32(math.NaN())
			}
			return value
		})
		if sourceError != nil {
			return sourceError
		}
		if err != nil {
			return err
		}
		hooks := inferenceHooks{}
		if progress != nil {
			hooks.progress = func(completed, total int) {
				progress(pipelineProgress{window: windowIndex, windows: windows, completed: completed, total: total})
			}
		}
		err = predict(ctx, inputLeft, inputRight, heads, func(head int, outputLeft, outputRight []float32) error {
			return assembler.accept(ctx, head, outputLeft, outputRight)
		}, hooks)
		if err != nil {
			return err
		}
		err = assembler.advance(ctx, func(head, start int, outputLeft, outputRight []float32) error {
			return streams[head].push(ctx, start, outputLeft, outputRight, func(first int, l, r []float32) error { return groups.accept(ctx, head, first, l, r) })
		})
		if err != nil {
			return err
		}
		if err := groups.finishSpan(ctx); err != nil {
			return err
		}
		windowIndex++
	}
	for _, stream := range streams {
		if stream.next != resources.sourceFrames || stream.received != resources.modelFrames {
			return errors.New("private separation did not reconstruct exact source duration")
		}
	}
	if groups.first != resources.sourceFrames {
		return errors.New("private separation residual duration mismatch")
	}
	return ctx.Err()
}

type groupAccumulator struct {
	resources pipelineResources
	source    [2][]float32
	sink      stemSink
	first     int
	received  [5]int
	sum       [2][]float64
	melody    [2][]float32
	output    [2][]float32
}

func newGroupAccumulator(resources pipelineResources, left, right []float32, sink stemSink) *groupAccumulator {
	groups := &groupAccumulator{resources: resources, source: [2][]float32{left, right}, sink: sink}
	for channel := range 2 {
		groups.sum[channel] = make([]float64, resources.originalSpan)
		groups.output[channel] = make([]float32, outputBlockFrames)
		if resources.stems == 5 {
			groups.melody[channel] = make([]float32, resources.originalSpan)
		}
	}
	return groups
}
func (groups *groupAccumulator) accept(ctx context.Context, head, start int, left, right []float32) error {
	if ctx == nil || head < 0 || head >= groups.resources.heads || start != groups.received[head] || len(left) != len(right) || len(left) > outputBlockFrames || start < groups.first || start-groups.first+len(left) > groups.resources.originalSpan {
		return errors.New("invalid original-rate trained span")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	offset := start - groups.first
	outputStem := head
	melody := groups.resources.stems == 5
	for channel, values := range [2][]float32{left, right} {
		for i, value := range values {
			if !finite32(value) {
				return errors.New("non-finite original-rate trained output")
			}
			if melody && head == 3 {
				groups.melody[channel][offset+i] = value
				continue
			}
			if melody && head == 4 {
				value += groups.melody[channel][offset+i]
				values[i] = value
			}
			if !finite32(value) {
				return errors.New("melody output exceeds finite range")
			}
			groups.sum[channel][offset+i] += float64(value)
		}
	}
	groups.received[head] += len(left)
	if melody && head == 3 {
		return nil
	}
	if melody && head == 4 {
		outputStem = 3
	}
	return groups.sink(outputStem, start, left, right)
}
func (groups *groupAccumulator) finishSpan(ctx context.Context) error {
	end := groups.received[0]
	for head := range groups.resources.heads {
		if groups.received[head] != end {
			return errors.New("original-rate trained heads lost alignment")
		}
	}
	if end > groups.resources.sourceFrames || end-groups.first > groups.resources.originalSpan {
		return errors.New("original-rate output span exceeded bound")
	}
	for first := groups.first; first < end; first += outputBlockFrames {
		if err := ctx.Err(); err != nil {
			return err
		}
		count := min(outputBlockFrames, end-first)
		for channel, destination := range groups.output {
			for i := range count {
				value := float32(float64(groups.source[channel][first+i]) - groups.sum[channel][first+i-groups.first])
				if !finite32(value) {
					return errors.New("residual exceeds finite output range")
				}
				destination[i] = value
			}
		}
		if err := groups.sink(groups.resources.stems-1, first, groups.output[0][:count], groups.output[1][:count]); err != nil {
			return err
		}
	}
	clear(groups.sum[0][:end-groups.first])
	clear(groups.sum[1][:end-groups.first])
	groups.first = end
	return ctx.Err()
}
