package steminfer

// cspell:words softmax GELU steminfer qkv

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
)

type networkWorkspace struct {
	hidden, features, rotations, weightArena, bandGamma, finalGamma []float32
	spectra                                                         []complex64
	spectrum                                                        spectrumWorkspace
	// Each lane runs one band or frame transformer at a time. Lane 0 also
	// holds the band-split and mask-head scratch, which run serially.
	lanes           []*transformerLane
	laneRows        int // rows each lane holds: max(frames, bands)
	frames, samples int
}

type transformerLane struct {
	normalized, qkv, inner, projected, gates, query, key, value, scores, frequencies []float32
}

const blockWeightElements = 32 + 256 + 1536*256 + 8*256 + 8 + 256*512 + 256 + 1024*256 + 1024 + 256*1024 + 256

func newTransformerLane(sequence int) *transformerLane {
	return &transformerLane{
		normalized:  make([]float32, sequence*516),
		qkv:         make([]float32, sequence*3*attentionInner),
		inner:       make([]float32, sequence*attentionInner),
		projected:   make([]float32, sequence*modelDimension),
		gates:       make([]float32, sequence*attentionHeads),
		query:       make([]float32, sequence*attentionHeadDimension),
		key:         make([]float32, sequence*attentionHeadDimension),
		value:       make([]float32, sequence*attentionHeadDimension),
		scores:      make([]float32, attentionTile*sequence),
		frequencies: make([]float32, sequence*modelDimension),
	}
}

func newNetworkWorkspace(samples, workers int) *networkWorkspace {
	frames := samples/fftHop + 1
	sequence := max(frames, len(bandBins))
	work := &networkWorkspace{
		frames: frames, samples: samples,
		hidden:      make([]float32, len(bandBins)*frames*modelDimension),
		features:    make([]float32, frames*featureCount),
		rotations:   make([]float32, sequence*attentionHeadDimension),
		weightArena: make([]float32, blockWeightElements),
		bandGamma:   make([]float32, 516), finalGamma: make([]float32, modelDimension),
		spectra:  make([]complex64, frames*spectrumBins*2),
		spectrum: newSpectrumWorkspace(frames),
		lanes:    make([]*transformerLane, max(1, workers)),
		laneRows: sequence,
	}
	for i := range work.lanes {
		work.lanes[i] = newTransformerLane(sequence)
	}
	return work
}
func normalizeRows(destination, input, gamma []float32, rows, width int) {
	scale := float32(math.Sqrt(float64(width)))
	for row := range rows {
		var sum float64
		for _, value := range input[row*width : (row+1)*width] {
			sum += float64(value) * float64(value)
		}
		denominator := math.Max(1e-12, math.Sqrt(sum))
		for column := range width {
			value := float32(float64(input[row*width+column]) / denominator)
			destination[row*width+column] = (value * scale) * gamma[column]
		}
	}
}
func addBias(values, bias []float32, rows, width int) {
	for row := range rows {
		for column := range width {
			values[row*width+column] += bias[column]
		}
	}
}
func sigmoid(value float32) float32 { return float32(1 / (1 + math.Exp(-float64(value)))) }

type blockWeights struct {
	rotary, gamma, qkv, gates, gatesBias, out   []float32
	ffGamma, ffOne, ffOneBias, ffTwo, ffTwoBias []float32
}

func (work *networkWorkspace) loadBlock(archive *weightArchive, layer, axis int) (blockWeights, error) {
	var result blockWeights
	prefix := fmt.Sprintf("layers.%d.%d.layers.0.", layer, axis)
	entries := []struct {
		suffix      string
		count       int
		destination *[]float32
	}{
		{"0.rotary_embed.freqs", 32, &result.rotary},
		{"0.norm.gamma", 256, &result.gamma},
		{"0.to_qkv.weight", 1536 * 256, &result.qkv},
		{"0.to_gates.weight", 8 * 256, &result.gates},
		{"0.to_gates.bias", 8, &result.gatesBias},
		{"0.to_out.0.weight", 256 * 512, &result.out},
		{"1.net.0.gamma", 256, &result.ffGamma},
		{"1.net.1.weight", 1024 * 256, &result.ffOne},
		{"1.net.1.bias", 1024, &result.ffOneBias},
		{"1.net.4.weight", 256 * 1024, &result.ffTwo},
		{"1.net.4.bias", 256, &result.ffTwoBias},
	}
	offset := 0
	for _, entry := range entries {
		data := work.weightArena[offset : offset+entry.count]
		if err := archive.tensorInto(prefix+entry.suffix, data); err != nil {
			return blockWeights{}, err
		}
		*entry.destination = data
		offset += entry.count
	}
	sequence := work.frames
	if axis == 1 {
		sequence = len(bandBins)
	}
	for row := range sequence {
		for pair, frequency := range result.rotary {
			angle := float32(row) * frequency
			sine, cosine := math.Sincos(float64(angle))
			work.rotations[row*64+pair*2] = float32(sine)
			work.rotations[row*64+pair*2+1] = float32(cosine)
		}
	}
	return result, nil
}

// transformer runs one block over groups independent sequences stored back
// to back in input. Projections and the feed-forward run over all rows at
// once; attention and rotary positions stay within each sequence.
func (lane *transformerLane) transformer(ctx context.Context, rotations, input []float32, sequence, groups int, weights blockWeights) error {
	total := sequence * groups
	norm := lane.normalized[:total*256]
	qkv := lane.qkv[:total*1536]
	gates := lane.gates[:total*8]
	inner := lane.inner[:total*512]
	projected := lane.projected[:total*256]
	normalizeRows(norm, input, weights.gamma, total, 256)
	if err := multiply(ctx, qkv, norm, weights.qkv, total, 1536, 256, true); err != nil {
		return err
	}
	if err := multiply(ctx, gates, norm, weights.gates, total, 8, 256, true); err != nil {
		return err
	}
	addBias(gates, weights.gatesBias, total, 8)
	for head := range 8 {
		if err := ctx.Err(); err != nil {
			return err
		}
		query, key, value := lane.query[:total*64], lane.key[:total*64], lane.value[:total*64]
		for row := range total {
			position := row % sequence
			for pair := range 32 {
				s := rotations[position*64+pair*2]
				c := rotations[position*64+pair*2+1]
				for source, destination := range [2][]float32{query, key} {
					offset := row*1536 + source*512 + head*64 + pair*2
					a, b := qkv[offset], qkv[offset+1]
					destination[row*64+pair*2] = a*c - b*s
					destination[row*64+pair*2+1] = b*c + a*s
				}
			}
			copy(value[row*64:(row+1)*64], qkv[row*1536+1024+head*64:row*1536+1024+(head+1)*64])
		}
		for group := range groups {
			base := group * sequence
			groupKey, groupValue := key[base*64:(base+sequence)*64], value[base*64:(base+sequence)*64]
			for first := 0; first < sequence; first += attentionTile {
				rows := min(attentionTile, sequence-first)
				scores := lane.scores[:rows*sequence]
				if err := multiply(ctx, scores, query[(base+first)*64:(base+first+rows)*64], groupKey, rows, sequence, 64, true); err != nil {
					return err
				}
				if err := attentionSoftmax(ctx, scores, rows, sequence); err != nil {
					return err
				}
				output := lane.normalized[:rows*64]
				if err := multiply(ctx, output, scores, groupValue, rows, 64, sequence, false); err != nil {
					return err
				}
				for row := range rows {
					gate := sigmoid(gates[(base+first+row)*8+head])
					for column := range 64 {
						inner[(base+first+row)*512+head*64+column] = output[row*64+column] * gate
					}
				}
			}
		}
	}
	if err := multiply(ctx, projected, inner, weights.out, total, 256, 512, true); err != nil {
		return err
	}
	for i := range input[:total*256] {
		input[i] += projected[i]
	}
	normalizeRows(norm, input, weights.ffGamma, total, 256)
	hidden := lane.qkv[:total*1024]
	if err := multiply(ctx, hidden, norm, weights.ffOne, total, 1024, 256, true); err != nil {
		return err
	}
	addBias(hidden, weights.ffOneBias, total, 1024)
	if err := applyGELU(ctx, hidden); err != nil {
		return err
	}
	if err := multiply(ctx, projected, hidden, weights.ffTwo, total, 256, 1024, true); err != nil {
		return err
	}
	addBias(projected, weights.ffTwoBias, total, 256)
	for i := range input[:total*256] {
		input[i] += projected[i]
	}
	return nil
}
func (work *networkWorkspace) splitBands(ctx context.Context, archive *weightArchive) error {
	offset := 0
	for band, bins := range bandBins {
		if err := ctx.Err(); err != nil {
			return err
		}
		width := bins * 4
		gamma := work.bandGamma[:width]
		matrix := work.weightArena[:256*width]
		bias := work.finalGamma[:256]
		prefix := fmt.Sprintf("band_split.to_features.%d.", band)
		if err := archive.tensorInto(prefix+"0.gamma", gamma); err != nil {
			return err
		}
		if err := archive.tensorInto(prefix+"1.weight", matrix); err != nil {
			return err
		}
		if err := archive.tensorInto(prefix+"1.bias", bias); err != nil {
			return err
		}
		copied := work.lanes[0].qkv[:work.frames*width]
		for row := range work.frames {
			copy(copied[row*width:(row+1)*width], work.features[row*featureCount+offset:row*featureCount+offset+width])
		}
		norm := work.lanes[0].normalized[:work.frames*width]
		normalizeRows(norm, copied, gamma, work.frames, width)
		output := work.hidden[band*work.frames*256 : (band+1)*work.frames*256]
		if err := multiply(ctx, output, norm, matrix, work.frames, 256, width, true); err != nil {
			return err
		}
		addBias(output, bias, work.frames, 256)
		offset += width
	}
	return nil
}
func (work *networkWorkspace) layer(ctx context.Context, archive *weightArchive, layer int, trace func(string, []float32), report *inferenceProgress) error {
	for axis := range 2 {
		weights, err := work.loadBlock(archive, layer, axis)
		if err != nil {
			return err
		}
		if axis == 0 {
			err = work.parallel(ctx, len(bandBins), func(lane *transformerLane, band int) error {
				return lane.transformer(ctx, work.rotations, work.hidden[band*work.frames*256:(band+1)*work.frames*256], work.frames, 1, weights)
			})
		} else {
			err = work.frequencyAxis(ctx, weights)
		}
		if err != nil {
			return err
		}
		if trace != nil {
			suffix := "time"
			if axis == 1 {
				suffix = "frequency"
			}
			trace(fmt.Sprintf("layer%d.%s", layer, suffix), work.hidden)
		}
		if err := report.advance(ctx); err != nil {
			return err
		}
	}
	return nil
}

// frequencyAxis runs one frequency-axis block over every frame. Sequences
// are short (62 bands), so each task packs as many frames as a lane holds
// into one batch.
func (work *networkWorkspace) frequencyAxis(ctx context.Context, weights blockWeights) error {
	bands := len(bandBins)
	perBatch := max(1, work.laneRows/bands)
	batches := (work.frames + perBatch - 1) / perBatch
	return work.parallel(ctx, batches, func(lane *transformerLane, batch int) error {
		first := batch * perBatch
		count := min(perBatch, work.frames-first)
		for local := range count {
			frame := first + local
			for band := range bands {
				copy(lane.frequencies[(local*bands+band)*256:(local*bands+band+1)*256], work.hidden[(band*work.frames+frame)*256:(band*work.frames+frame+1)*256])
			}
		}
		if err := lane.transformer(ctx, work.rotations, lane.frequencies, bands, count, weights); err != nil {
			return err
		}
		for local := range count {
			frame := first + local
			for band := range bands {
				copy(work.hidden[(band*work.frames+frame)*256:(band*work.frames+frame+1)*256], lane.frequencies[(local*bands+band)*256:(local*bands+band+1)*256])
			}
		}
		return nil
	})
}

// parallel runs task for every index in [0, count) across the workspace lanes.
// Tasks write disjoint slices of shared state, so results do not depend on
// scheduling. The first error cancels the remaining tasks.
func (work *networkWorkspace) parallel(ctx context.Context, count int, task func(*transformerLane, int) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var next atomic.Int64
	var first error
	var once sync.Once
	var wait sync.WaitGroup
	for _, lane := range work.lanes[:min(len(work.lanes), count)] {
		wait.Go(func() {
			for {
				index := int(next.Add(1) - 1)
				if index >= count || ctx.Err() != nil {
					return
				}
				if err := task(lane, index); err != nil {
					once.Do(func() { first = err; cancel() })
					return
				}
			}
		})
	}
	wait.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}
