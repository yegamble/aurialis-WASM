package steminfer

// cspell:words BLAS steminfer

// workingStorageBytes is the admitted fixed-array storage for one window. It
// excludes the immutable model archive, caller input/output retention, small
// bounded Go metadata and any implementation-internal system BLAS workspace.
// The private file loader currently owns modelBytes separately; embedded model
// publication and the job's shared static-model reservation are later slices.
func workingStorageBytes(samples int) int64 {
	if samples <= fftSize/2 || samples > maximumWindowSamples {
		return 0
	}
	frames := int64(samples/fftHop + 1)
	sequence := max(frames, int64(len(bandBins)))
	full := int64(fftSize) + int64(fftHop)*(frames-1)
	floatElements := int64(len(bandBins))*frames*modelDimension + frames*featureCount +
		sequence*(516+3*attentionInner+attentionInner+modelDimension+attentionHeads+3*attentionHeadDimension+attentionTile+attentionHeadDimension) +
		int64(len(bandBins))*modelDimension + blockWeightElements + 516 + modelDimension + fftSize + 3*full
	return floatElements*4 + frames*spectrumBins*2*8 + fftSize*16
}
func (work *networkWorkspace) storageBytes() int64 {
	var count int64
	for _, values := range [][]float32{work.hidden, work.features, work.normalized, work.qkv, work.inner, work.projected, work.gates, work.query, work.key, work.value, work.scores, work.rotations, work.frequencies, work.weightArena, work.bandGamma, work.finalGamma, work.spectrum.window, work.spectrum.envelope, work.spectrum.left, work.spectrum.right} {
		count += int64(cap(values)) * 4
	}
	return count + int64(cap(work.spectra))*8 + int64(cap(work.spectrum.fft))*16
}
