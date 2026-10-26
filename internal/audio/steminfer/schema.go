package steminfer

// cspell:words steminfer dtype CFLAGS DACCELERATE LAPACK cblas sgemm Cblas GFLOP

import "fmt"

const modelDimension = 256
const attentionHeads = 8
const attentionHeadDimension = 64
const attentionInner = attentionHeads * attentionHeadDimension
const transformerHidden = 1024
const maskHidden = 512
const modelDepth = 12
const fftSize = 2048
const fftHop = 512
const spectrumBins = fftSize/2 + 1
const featureCount = spectrumBins * 4
const maximumWindowSamples = 882000
const maximumSequence = maximumWindowSamples/fftHop + 1

var bandBins = [...]int{2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 12, 12, 12, 12, 12, 12, 12, 12, 24, 24, 24, 24, 24, 24, 24, 24, 48, 48, 48, 48, 48, 48, 48, 48, 128, 129}

func expectedModelSchema() map[string]tensorShape {
	schema := make(map[string]tensorShape, 1691)
	for band, bins := range bandBins {
		prefix := fmt.Sprintf("band_split.to_features.%d.", band)
		schema[prefix+"0.gamma"] = tensorShape{bins * 4}
		schema[prefix+"1.weight"] = tensorShape{modelDimension, bins * 4}
		schema[prefix+"1.bias"] = tensorShape{modelDimension}
	}
	for layer := range modelDepth {
		for axis := range 2 {
			prefix := fmt.Sprintf("layers.%d.%d.layers.0.", layer, axis)
			for suffix, shape := range map[string]tensorShape{"0.rotary_embed.freqs": {attentionHeadDimension / 2}, "0.norm.gamma": {modelDimension}, "0.to_qkv.weight": {3 * attentionInner, modelDimension}, "0.to_gates.weight": {attentionHeads, modelDimension}, "0.to_gates.bias": {attentionHeads}, "0.to_out.0.weight": {modelDimension, attentionInner}, "1.net.0.gamma": {modelDimension}, "1.net.1.weight": {transformerHidden, modelDimension}, "1.net.1.bias": {transformerHidden}, "1.net.4.weight": {modelDimension, transformerHidden}, "1.net.4.bias": {modelDimension}} {
				schema[prefix+suffix] = shape
			}
		}
	}
	schema["final_norm.gamma"] = tensorShape{modelDimension}
	for head := range 5 {
		for band, bins := range bandBins {
			prefix := fmt.Sprintf("mask_estimators.%d.to_freqs.%d.0.", head, band)
			schema[prefix+"0.weight"] = tensorShape{maskHidden, modelDimension}
			schema[prefix+"0.bias"] = tensorShape{maskHidden}
			schema[prefix+"2.weight"] = tensorShape{bins * 8, maskHidden}
			schema[prefix+"2.bias"] = tensorShape{bins * 8}
		}
	}
	return schema
}
