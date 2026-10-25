package steminfer

// cspell:words softmax GELU steminfer qkv

import (
	"context"
	"fmt"
	"math"
)

type networkWorkspace struct {
	hidden, features, normalized, qkv, inner, projected, gates, query, key, value, scores, rotations, frequencies, weightArena, bandGamma, finalGamma []float32
	spectra                                                                                                                                           []complex64
	spectrum                                                                                                                                          spectrumWorkspace
	frames, samples                                                                                                                                   int
}

const blockWeightElements = 32 + 256 + 1536*256 + 8*256 + 8 + 256*512 + 256 + 1024*256 + 1024 + 256*1024 + 256

func newNetworkWorkspace(samples int) *networkWorkspace {
	frames := samples/fftHop + 1
	sequence := max(frames, len(bandBins))
	return &networkWorkspace{
		frames: frames, samples: samples,
		hidden:      make([]float32, len(bandBins)*frames*modelDimension),
		features:    make([]float32, frames*featureCount),
		normalized:  make([]float32, sequence*516),
		qkv:         make([]float32, sequence*3*attentionInner),
		inner:       make([]float32, sequence*attentionInner),
		projected:   make([]float32, sequence*modelDimension),
		gates:       make([]float32, sequence*attentionHeads),
		query:       make([]float32, sequence*attentionHeadDimension),
		key:         make([]float32, sequence*attentionHeadDimension),
		value:       make([]float32, sequence*attentionHeadDimension),
		scores:      make([]float32, attentionTile*sequence),
		rotations:   make([]float32, sequence*attentionHeadDimension),
		frequencies: make([]float32, len(bandBins)*modelDimension),
		weightArena: make([]float32, blockWeightElements),
		bandGamma:   make([]float32, 516), finalGamma: make([]float32, modelDimension),
		spectra:  make([]complex64, frames*spectrumBins*2),
		spectrum: newSpectrumWorkspace(frames),
	}
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
func (work *networkWorkspace) transformer(ctx context.Context, input []float32, sequence int, weights blockWeights) error {
	norm := work.normalized[:sequence*256]
	qkv := work.qkv[:sequence*1536]
	gates := work.gates[:sequence*8]
	inner := work.inner[:sequence*512]
	projected := work.projected[:sequence*256]
	normalizeRows(norm, input, weights.gamma, sequence, 256)
	if err := multiply(ctx, qkv, norm, weights.qkv, sequence, 1536, 256, true); err != nil {
		return err
	}
	if err := multiply(ctx, gates, norm, weights.gates, sequence, 8, 256, true); err != nil {
		return err
	}
	addBias(gates, weights.gatesBias, sequence, 8)
	for head := range 8 {
		if err := ctx.Err(); err != nil {
			return err
		}
		query, key, value := work.query[:sequence*64], work.key[:sequence*64], work.value[:sequence*64]
		for row := range sequence {
			for pair := range 32 {
				s := work.rotations[row*64+pair*2]
				c := work.rotations[row*64+pair*2+1]
				for source, destination := range [2][]float32{query, key} {
					offset := row*1536 + source*512 + head*64 + pair*2
					a, b := qkv[offset], qkv[offset+1]
					destination[row*64+pair*2] = a*c - b*s
					destination[row*64+pair*2+1] = b*c + a*s
				}
			}
			copy(value[row*64:(row+1)*64], qkv[row*1536+1024+head*64:row*1536+1024+(head+1)*64])
		}
		for first := 0; first < sequence; first += attentionTile {
			rows := min(attentionTile, sequence-first)
			scores := work.scores[:rows*sequence]
			if err := multiply(ctx, scores, query[first*64:(first+rows)*64], key, rows, sequence, 64, true); err != nil {
				return err
			}
			if err := attentionSoftmax(ctx, scores, rows, sequence); err != nil {
				return err
			}
			output := work.normalized[:rows*64]
			if err := multiply(ctx, output, scores, value, rows, 64, sequence, false); err != nil {
				return err
			}
			for row := range rows {
				gate := sigmoid(gates[(first+row)*8+head])
				for column := range 64 {
					inner[(first+row)*512+head*64+column] = output[row*64+column] * gate
				}
			}
		}
	}
	if err := multiply(ctx, projected, inner, weights.out, sequence, 256, 512, true); err != nil {
		return err
	}
	for i := range input {
		input[i] += projected[i]
	}
	normalizeRows(norm, input, weights.ffGamma, sequence, 256)
	hidden := work.qkv[:sequence*1024]
	if err := multiply(ctx, hidden, norm, weights.ffOne, sequence, 1024, 256, true); err != nil {
		return err
	}
	addBias(hidden, weights.ffOneBias, sequence, 1024)
	if err := applyGELU(ctx, hidden); err != nil {
		return err
	}
	if err := multiply(ctx, projected, hidden, weights.ffTwo, sequence, 256, 1024, true); err != nil {
		return err
	}
	addBias(projected, weights.ffTwoBias, sequence, 256)
	for i := range input {
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
		copied := work.qkv[:work.frames*width]
		for row := range work.frames {
			copy(copied[row*width:(row+1)*width], work.features[row*featureCount+offset:row*featureCount+offset+width])
		}
		norm := work.normalized[:work.frames*width]
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
			for band := range bandBins {
				if err := work.transformer(ctx, work.hidden[band*work.frames*256:(band+1)*work.frames*256], work.frames, weights); err != nil {
					return err
				}
			}
		} else {
			for frame := range work.frames {
				for band := range bandBins {
					copy(work.frequencies[band*256:(band+1)*256], work.hidden[(band*work.frames+frame)*256:(band*work.frames+frame+1)*256])
				}
				if err := work.transformer(ctx, work.frequencies, len(bandBins), weights); err != nil {
					return err
				}
				for band := range bandBins {
					copy(work.hidden[(band*work.frames+frame)*256:(band*work.frames+frame+1)*256], work.frequencies[band*256:(band+1)*256])
				}
			}
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
