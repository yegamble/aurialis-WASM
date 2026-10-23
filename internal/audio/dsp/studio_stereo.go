package dsp

// A shared first Butterworth section produces LP2 and HP2 simultaneously. Each
// branch has its own second section, so both are genuine LR4 responses at the
// actual requested cutoff, with matching phase and an all-pass sum.
type studioLR4Bank struct {
	coeffs           svfCoeffs
	first, low, high [2]svfState
}

func prepareStudioLR4(rate, crossover float64) studioLR4Bank {
	return studioLR4Bank{coeffs: computeButterworthSVF(rate, crossover)}
}

func (s *studioLR4Bank) process(mid, side float64) (float64, float64, float64) {
	input, low, high := [2]float64{mid, side}, [2]float64{}, [2]float64{}
	for ch, sample := range input {
		lo, hi := processSVFLowHigh(s.coeffs, &s.first[ch], sample)
		low[ch], _ = processSVFLowHigh(s.coeffs, &s.low[ch], lo)
		_, high[ch] = processSVFLowHigh(s.coeffs, &s.high[ch], hi)
	}
	return low[0] + high[0], low[1], high[1]
}
