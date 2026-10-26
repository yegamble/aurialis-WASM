package steminfer

// cspell:words steminfer

import (
	"context"
	"errors"
	"fmt"
)

// windowRunner runs the network on one fixed-size window.
// A future job owner must admit its static weights and complete working storage
// before construction, reuse one window size, and consume/copy callback samples
// before returning. No source-length output buffers are retained here.
type inferenceHooks struct {
	trace    func(string, []float32)
	progress func(completed, total int)
}
type inferenceProgress struct {
	completed, total int
	notify           func(int, int)
}

func (report *inferenceProgress) advance(ctx context.Context) error {
	report.completed++
	if report.notify != nil {
		report.notify(report.completed, report.total)
	}
	return ctx.Err()
}

type windowRunner struct {
	archive *weightArchive
	work    *networkWorkspace
	gate    chan struct{}
}

func newWindowRunner(ctx context.Context, archive *weightArchive, samples, workers int) (*windowRunner, error) {
	if workers < 1 || workers > maximumWorkers || ctx == nil || archive == nil || len(archive.tensors) != 1691 || samples <= fftSize/2 || samples > maximumWindowSamples {
		return nil, errors.New("invalid bounded inference runner")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &windowRunner{archive: archive, work: newNetworkWorkspace(samples, workers), gate: make(chan struct{}, 1)}, nil
}
func (runner *windowRunner) predict(ctx context.Context, left, right []float32, heads []int, consume func(int, []float32, []float32) error, hooks inferenceHooks) error {
	if ctx == nil || runner == nil || runner.work == nil || len(left) != runner.work.samples || len(right) != len(left) || len(heads) < 1 || len(heads) > 5 || consume == nil {
		return errors.New("invalid model inference request")
	}
	seen := [5]bool{}
	for _, head := range heads {
		if head < 0 || head >= len(seen) || seen[head] {
			return errors.New("invalid or duplicate trained output head")
		}
		seen[head] = true
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case runner.gate <- struct{}{}:
		defer func() { <-runner.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	report := inferenceProgress{total: 3 + 2*modelDepth + len(heads), notify: hooks.progress}
	if report.notify != nil {
		report.notify(0, report.total)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	trace := hooks.trace
	work := runner.work
	if err := work.spectrum.features(ctx, left, right, work.features); err != nil {
		return err
	}
	if trace != nil {
		trace("features", work.features)
	}
	if err := report.advance(ctx); err != nil {
		return err
	}
	if err := work.splitBands(ctx, runner.archive); err != nil {
		return err
	}
	if trace != nil {
		trace("band_split", work.hidden)
	}
	if err := report.advance(ctx); err != nil {
		return err
	}
	for layer := range modelDepth {
		if err := work.layer(ctx, runner.archive, layer, trace, &report); err != nil {
			return err
		}
	}
	if err := runner.archive.tensorInto("final_norm.gamma", work.finalGamma); err != nil {
		return err
	}
	normalizeRows(work.hidden, work.hidden, work.finalGamma, len(bandBins)*work.frames, 256)
	if trace != nil {
		trace("hidden", work.hidden)
	}
	if err := report.advance(ctx); err != nil {
		return err
	}
	for _, head := range heads {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := work.maskHead(ctx, runner.archive, head, trace); err != nil {
			return err
		}
		l, r, err := work.spectrum.reconstruct(ctx, work.spectra, len(left), true)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := consume(head, l, r); err != nil {
			return err
		}
		if err := report.advance(ctx); err != nil {
			return err
		}
	}
	return nil
}
func (work *networkWorkspace) maskHead(ctx context.Context, archive *weightArchive, head int, trace func(string, []float32)) error {
	offset := 0
	var tracedMask []float32
	if trace != nil {
		tracedMask = make([]float32, len(work.features))
	}
	for band, bins := range bandBins {
		if err := ctx.Err(); err != nil {
			return err
		}
		width := bins * 4
		prefix := fmt.Sprintf("mask_estimators.%d.to_freqs.%d.0.", head, band)
		firstWeights := work.weightArena[:512*256]
		firstBias := work.weightArena[512*256 : 512*256+512]
		secondStart := 512*256 + 512
		secondWeights := work.weightArena[secondStart : secondStart+2*width*512]
		secondBias := work.weightArena[secondStart+2*width*512 : secondStart+2*width*512+2*width]
		for _, entry := range []struct {
			name        string
			destination []float32
		}{{"0.weight", firstWeights}, {"0.bias", firstBias}, {"2.weight", secondWeights}, {"2.bias", secondBias}} {
			if err := archive.tensorInto(prefix+entry.name, entry.destination); err != nil {
				return err
			}
		}
		hidden := work.lanes[0].inner[:work.frames*512]
		input := work.hidden[band*work.frames*256 : (band+1)*work.frames*256]
		if err := multiply(ctx, hidden, input, firstWeights, work.frames, 512, 256, true); err != nil {
			return err
		}
		addBias(hidden, firstBias, work.frames, 512)
		if err := applyTanh(ctx, hidden); err != nil {
			return err
		}
		output := work.lanes[0].qkv[:work.frames*2*width]
		if err := multiply(ctx, output, hidden, secondWeights, work.frames, 2*width, 512, true); err != nil {
			return err
		}
		addBias(output, secondBias, work.frames, 2*width)
		for row := range work.frames {
			for i := 0; i < width; i += 2 {
				mask := complex(output[row*2*width+i]*sigmoid(output[row*2*width+width+i]), output[row*2*width+i+1]*sigmoid(output[row*2*width+width+i+1]))
				feature := row*featureCount + offset + i
				original := complex(work.features[feature], work.features[feature+1])
				binChannel := (offset + i) / 2
				work.spectra[row*spectrumBins*2+binChannel] = original * mask
				if trace != nil {
					tracedMask[feature] = real(mask)
					tracedMask[feature+1] = imag(mask)
				}
			}
		}
		offset += width
	}
	if trace != nil {
		trace("mask."+[5]string{"vocal", "drums", "bass", "guitar", "piano"}[head], tracedMask)
	}
	return nil
}
