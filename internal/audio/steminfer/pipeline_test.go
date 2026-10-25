package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"math"
	"testing"
)

var testHeadAmounts = [5]float32{.11, .17, .23, .19, .13}

func linearTestPredictor(ctx context.Context, left, right []float32, heads []int, consume func(int, []float32, []float32) error, hooks inferenceHooks) error {
	if hooks.progress != nil {
		hooks.progress(0, 1)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	l, r := make([]float32, len(left)), make([]float32, len(right))
	for _, head := range heads {
		for i := range left {
			l[i] = left[i] * testHeadAmounts[head]
			r[i] = right[i] * testHeadAmounts[head]
		}
		if err := consume(head, l, r); err != nil {
			return err
		}
	}
	if hooks.progress != nil {
		hooks.progress(1, 1)
	}
	return ctx.Err()
}
func TestPrivatePipelinePreservesOriginalPCMAndAllTwoToSixGroups(t *testing.T) {
	for _, rate := range []int{8001, 44100, 48000, 192000} {
		for stems := 2; stems <= 6; stems++ {
			const frames = 2053
			resources, err := estimatePipeline(rate, frames, stems, 2048, 2)
			if err != nil {
				t.Fatal(err)
			}
			source := [2][]float32{make([]float32, frames), make([]float32, frames)}
			for i := range frames {
				source[0][i] = float32(.1 + .2*math.Sin(2*math.Pi*997*float64(i)/float64(rate)))
				source[1][i] = float32(-.03 + .15*math.Cos(2*math.Pi*631*float64(i)/float64(rate)))
			}
			source[0][0] = .6
			source[1][frames-1] = -.4
			outputs := make([][2][]float32, stems)
			lastWindow, lastStep, windows := -1, -1, 0
			err = runPipelineCore(context.Background(), resources, source[0], source[1], linearTestPredictor, func(stem, start int, left, right []float32) error {
				if stem < 0 || stem >= stems || start != len(outputs[stem][0]) || len(left) > outputBlockFrames {
					t.Fatal("invalid original-rate callback", stem, start)
				}
				outputs[stem][0] = append(outputs[stem][0], left...)
				outputs[stem][1] = append(outputs[stem][1], right...)
				return nil
			}, func(progress pipelineProgress) {
				if progress.window < lastWindow || progress.window > lastWindow+1 || (progress.window == lastWindow && progress.completed <= lastStep) {
					t.Fatal("progress lost monotonic window order")
				}
				if progress.window != lastWindow {
					lastStep = -1
				}
				lastWindow, lastStep, windows = progress.window, progress.completed, progress.windows
			})
			if err != nil {
				t.Fatalf("rate%d stems%d: %v", rate, stems, err)
			}
			if lastWindow != windows-1 || lastStep != 1 {
				t.Fatal("progress did not finish exact window count")
			}
			forward, err := newResamplePlan(context.Background(), rate, modelSampleRate)
			if err != nil {
				t.Fatal(err)
			}
			inverse, err := newResamplePlan(context.Background(), modelSampleRate, rate)
			if err != nil {
				t.Fatal(err)
			}
			expectedHeads := make([][2][]float32, resources.heads)
			for channel := range 2 {
				modelInput := make([]float32, resources.modelFrames)
				if err := forward.into(context.Background(), modelInput, source[channel], 0); err != nil {
					t.Fatal(err)
				}
				for head := range resources.heads {
					modelOutput := make([]float32, len(modelInput))
					for i, value := range modelInput {
						modelOutput[i] = value * testHeadAmounts[head]
					}
					expectedHeads[head][channel] = make([]float32, frames)
					if err := inverse.into(context.Background(), expectedHeads[head][channel], modelOutput, 0); err != nil {
						t.Fatal(err)
					}
				}
			}
			for channel := range 2 {
				for i := range frames {
					var sum float64
					for stem := range stems {
						if len(outputs[stem][channel]) != frames || !finite32(outputs[stem][channel][i]) {
							t.Fatal("original rate/frame layout changed")
						}
						sum += float64(outputs[stem][channel][i])
						if stem == stems-1 {
							continue
						}
						expected := expectedHeads[stem][channel][i]
						if stems == 5 && stem == 3 {
							expected = expectedHeads[3][channel][i] + expectedHeads[4][channel][i]
						}
						if math.Abs(float64(outputs[stem][channel][i]-expected)) > 2e-7 {
							t.Fatalf("rate%d stems%d group%d channel%d frame%d has a chunk/SRC seam", rate, stems, stem, channel, i)
						}
					}
					// This checks the actual delivered float32 groups plus residual against
					// actual original PCM, rather than against a reconstructed input copy.
					if math.Abs(sum-float64(source[channel][i])) > 3e-8 {
						t.Fatalf("original PCM reconstruction changed rate%d stems%d frame%d error%g", rate, stems, i, sum-float64(source[channel][i]))
					}
				}
			}
		}
	}
}
func TestPrivatePipelineShortSourceAndFullProductionWindow(t *testing.T) {
	for _, frames := range []int{1, 127, 129} {
		resources, err := estimatePipeline(48000, frames, 6, 2048, 2)
		if err != nil {
			t.Fatal(err)
		}
		left, right := make([]float32, frames), make([]float32, frames)
		left[0] = .5
		right[frames-1] = -.25
		counts := [6]int{}
		err = runPipelineCore(context.Background(), resources, left, right, linearTestPredictor, func(stem, start int, l, r []float32) error {
			if start != counts[stem] || len(l) != len(r) {
				t.Fatal("short stream lost continuity")
			}
			counts[stem] += len(l)
			return nil
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, count := range counts {
			if count != frames {
				t.Fatal("short original source duration changed")
			}
		}
	}
	resources, err := estimatePipeline(44100, 1, 2, maximumWindowSamples, 2)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	err = runPipelineCore(context.Background(), resources, []float32{.5}, []float32{-.25}, func(ctx context.Context, l, r []float32, heads []int, consume func(int, []float32, []float32) error, _ inferenceHooks) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(l) != 882000 || len(r) != 882000 || len(heads) != 1 {
			t.Fatal("production model context was shortened")
		}
		calls++
		zero := make([]float32, 882000)
		return consume(0, zero, zero)
	}, func(stem, _ int, l, r []float32) error {
		if len(l) != 1 || (stem == 1 && (l[0] != .5 || r[0] != -.25)) {
			t.Fatal("full-window short source residual changed")
		}
		return nil
	}, nil)
	if err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
}
func TestPrivatePipelineRejectsMissingReservationMalformedAndCanceledWork(t *testing.T) {
	sink := func(_, _ int, _, _ []float32) error { return nil }
	if err := runTrainedSeparation(context.Background(), nil, 44100, 6, []float32{1}, []float32{1}, 1, sink, nil); err == nil {
		t.Fatal("full graph accepted without reservation")
	}
	resources, err := estimatePipeline(44100, 129, 2, 2048, 2)
	if err != nil {
		t.Fatal(err)
	}
	source := make([]float32, 129)
	predicted := false
	predict := func(context.Context, []float32, []float32, []int, func(int, []float32, []float32) error, inferenceHooks) error {
		predicted = true
		return nil
	}
	broken := resources
	broken.originalSpan = -1
	if err := runPipelineCore(context.Background(), broken, source, source, predict, sink, nil); err == nil {
		t.Fatal("changed admission shape accepted")
	}
	invalid := append([]float32(nil), source...)
	invalid[128] = float32(math.NaN())
	if err := runPipelineCore(context.Background(), resources, invalid, source, predict, sink, nil); err == nil || predicted {
		t.Fatal("non-finite input reached model")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runPipelineCore(ctx, resources, source, source, predict, sink, nil); !errors.Is(err, context.Canceled) || predicted {
		t.Fatal("canceled input reached model", err)
	}
	failure := errors.New("sink rejected unpublished output")
	err = runPipelineCore(context.Background(), resources, source, source, linearTestPredictor, func(_, _ int, _, _ []float32) error { return failure }, nil)
	if !errors.Is(err, failure) {
		t.Fatal("sink failure lost", err)
	}
}
func TestPrivateResourcePlanSeparatesStaticAndRetainedBudgets(t *testing.T) {
	for _, rate := range []int{8001, 44100, 48000, 192000} {
		for stems := 2; stems <= 6; stems++ {
			resources, err := estimatePipeline(rate, 441000, stems, maximumWindowSamples, 2)
			if err != nil {
				t.Fatal(err)
			}
			if resources.window != 882000 || resources.staticModelBytes != modelBytes || resources.inputBytes != 441000*8 || resources.retainedOutputBytes != int64(441000*stems*8) || resources.requiredJobBytes <= resources.workingBytes+resources.inputBytes+resources.retainedOutputBytes {
				t.Fatal("resource categories were omitted")
			}
			if resources.requiredJobBytes > maximumPrivateJobBytes {
				t.Fatal("unbounded private admission")
			}
		}
	}
	for _, request := range [][3]int{{0, 1, 2}, {44100, 0, 6}, {44100, maximumSourceFrames + 1, 6}, {44100, 1, 7}, {8000, maximumSourceFrames, 6}} {
		if _, err := estimatePipeline(request[0], request[1], request[2], maximumWindowSamples, 2); err == nil {
			t.Fatal("unbounded source/model/retention admitted", request)
		}
	}
	// The longest admitted source still fits the per-job ceiling.
	if resources, err := estimatePipeline(44100, maximumSourceFrames, 6, maximumWindowSamples, maximumWorkers); err != nil || resources.requiredJobBytes > maximumPrivateJobBytes {
		t.Fatal("longest source exceeds the job ceiling", err)
	}
}

func TestPrivateResourceArraysMatchEstimate(t *testing.T) {
	resources, err := estimatePipeline(8001, 1027, 5, 2048, 2)
	if err != nil {
		t.Fatal(err)
	}
	forward, err := newResamplePlan(context.Background(), resources.sourceRate, modelSampleRate)
	if err != nil {
		t.Fatal(err)
	}
	inverse, err := newResamplePlan(context.Background(), modelSampleRate, resources.sourceRate)
	if err != nil {
		t.Fatal(err)
	}
	assembler, err := newChunkAssembler(resources.modelFrames, resources.window, resources.heads)
	if err != nil {
		t.Fatal(err)
	}
	var overlap int64
	for _, values := range [][]float32{assembler.window, assembler.counter, assembler.left, assembler.right} {
		overlap += int64(cap(values)) * 4
	}
	for head := range assembler.heads {
		for _, values := range assembler.sums[head] {
			overlap += int64(cap(values)) * 4
		}
	}
	var streaming int64
	for range resources.heads {
		stream, err := newResampleStream(inverse, resources.modelFrames, resources.sourceFrames)
		if err != nil {
			t.Fatal(err)
		}
		for channel := range 2 {
			streaming += int64(cap(stream.carry[channel])+cap(stream.output[channel])) * 4
		}
	}
	groups := newGroupAccumulator(resources, make([]float32, 1027), make([]float32, 1027), func(_, _ int, _, _ []float32) error { return nil })
	var grouping int64
	for channel := range 2 {
		grouping += int64(cap(groups.sum[channel]))*8 + int64(cap(groups.melody[channel])+cap(groups.output[channel]))*4
	}
	src := int64(cap(forward.coefficients)+cap(inverse.coefficients)) * 4
	graph := newNetworkWorkspace(resources.window, resources.workers).storageBytes()
	if overlap != resources.overlapBytes || streaming != resources.streamBytes || grouping != resources.groupBytes || src != resources.resampleBytes || graph != resources.graphBytes || graph+overlap+streaming+grouping+src != resources.workingBytes {
		t.Fatalf("array reservation mismatch graph%d overlap%d stream%d groups%d SRC%d estimate%+v", graph, overlap, streaming, grouping, src, resources)
	}
	for _, rate := range []int{8001, 44100, 192000} {
		example, err := estimatePipeline(rate, rate*10, 6, maximumWindowSamples, 2)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("rate%d10s6stems: graph%d overlap%d SRC%d stream%d groups%d input%d retention%d static%d totalJobReservation%d", rate, example.graphBytes, example.overlapBytes, example.resampleBytes, example.streamBytes, example.groupBytes, example.inputBytes, example.retainedOutputBytes, example.staticModelBytes, example.requiredJobBytes)
	}
}

func TestPrivateStemNamesAreSelectedHeadsPlusResidual(t *testing.T) {
	expected := map[int][6]string{
		2: {"vocals", "instrumental"}, 3: {"vocals", "drums", "rest"}, 4: {"vocals", "drums", "bass", "other"},
		5: {"vocals", "drums", "bass", "melody", "other"}, 6: {"vocals", "drums", "bass", "guitar", "piano", "other"},
	}
	for stems, want := range expected {
		got, err := stemNames(stems)
		if err != nil || got != want {
			t.Fatal("private grouping names changed", stems, got, err)
		}
	}
	if _, err := stemNames(7); err == nil {
		t.Fatal("unavailable group count accepted")
	}
}
