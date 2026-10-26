package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
)

// StemNames lists the outputs for 2–6 stems, in sink order. The last stem is
// always the source minus the others, so the stems sum back to the mix.
func StemNames(stems int) ([]string, error) {
	names, err := stemNames(stems)
	if err != nil {
		return nil, err
	}
	return names[:stems], nil
}

// JobBytes is the memory one Separate call needs, including the input and
// the caller's retained stem PCM but excluding the shared model. It fails for
// requests beyond the per-job ceiling.
func JobBytes(rate, frames, stems int) (int64, error) {
	resources, err := estimatePipeline(rate, frames, stems, maximumWindowSamples, defaultWorkers())
	if err != nil {
		return 0, err
	}
	return resources.requiredJobBytes, nil
}

// Separate splits stereo PCM at rate into stems. sink receives each stem's
// samples in order as they finish; slices are reused after sink returns.
// progress, if set, receives the completed fraction in [0, 1]. Output written
// before an error is incomplete and must be discarded.
func (model *Model) Separate(ctx context.Context, rate, stems int, left, right []float32, sink func(stem, start int, left, right []float32) error, progress func(fraction float64)) error {
	if model == nil || model.archive == nil {
		return errors.New("stem model is not loaded")
	}
	required, err := JobBytes(rate, len(left), stems)
	if err != nil {
		return err
	}
	var report func(pipelineProgress)
	if progress != nil {
		report = func(p pipelineProgress) {
			if p.windows > 0 && p.total > 0 {
				progress((float64(p.window) + float64(p.completed)/float64(p.total)) / float64(p.windows))
			}
		}
	}
	return runTrainedSeparation(ctx, model.archive, rate, stems, left, right, required, sink, report)
}
