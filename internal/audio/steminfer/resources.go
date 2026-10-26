package steminfer

// cspell:words BLAS steminfer

// workingStorageBytes is the admitted fixed-array storage for one window run
// by the given number of transformer lanes. It excludes the immutable model
// archive, caller input/output retention, small bounded Go metadata and any
// implementation-internal system BLAS workspace.
func workingStorageBytes(samples, workers int) int64 {
	if samples <= fftSize/2 || samples > maximumWindowSamples || workers < 1 || workers > maximumWorkers {
		return 0
	}
	frames := int64(samples/fftHop + 1)
	sequence := max(frames, int64(len(bandBins)))
	full := int64(fftSize) + int64(fftHop)*(frames-1)
	lane := sequence*(516+3*attentionInner+attentionInner+modelDimension+attentionHeads+3*attentionHeadDimension+attentionTile) + sequence*modelDimension
	floatElements := int64(len(bandBins))*frames*modelDimension + frames*featureCount + sequence*attentionHeadDimension +
		int64(workers)*lane + blockWeightElements + 516 + modelDimension + fftSize + 3*full
	return floatElements*4 + frames*spectrumBins*2*8 + fftSize*16
}
func (work *networkWorkspace) storageBytes() int64 {
	var count int64
	for _, values := range [][]float32{work.hidden, work.features, work.rotations, work.weightArena, work.bandGamma, work.finalGamma, work.spectrum.window, work.spectrum.envelope, work.spectrum.left, work.spectrum.right} {
		count += int64(cap(values)) * 4
	}
	for _, lane := range work.lanes {
		for _, values := range [][]float32{lane.normalized, lane.qkv, lane.inner, lane.projected, lane.gates, lane.query, lane.key, lane.value, lane.scores, lane.frequencies} {
			count += int64(cap(values)) * 4
		}
	}
	return count + int64(cap(work.spectra))*8 + int64(cap(work.spectrum.fft))*16
}
