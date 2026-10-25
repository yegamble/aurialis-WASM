package dsp

import "math"

// NoReading marks a loudness value whose measurement window is not yet full
// or whose gated block set is empty.
const NoReading = -200.0

const (
	liveSubBlocks  = 30 // 30 × 100 ms = the 3 s short-term window.
	liveBinsPerLU  = 20 // 0.05 LU histogram resolution.
	liveHistMinLU  = -70.0
	liveHistMaxLU  = 10.0
	liveHistogramN = int((liveHistMaxLU - liveHistMinLU) * liveBinsPerLU)
)

// loudnessHistogram accumulates gated block energies in fixed 0.05 LU bins so
// integrated loudness and loudness range need no per-block storage.
type loudnessHistogram struct {
	count  [liveHistogramN]uint32
	energy [liveHistogramN]float64
	total  uint32
}

func (h *loudnessHistogram) add(energy float64) {
	lu := loudness(energy)
	if lu <= liveHistMinLU {
		return // The -70 LUFS absolute gate.
	}
	bin := min(int((lu-liveHistMinLU)*liveBinsPerLU), liveHistogramN-1)
	h.count[bin]++
	h.energy[bin] += energy
	h.total++
}

// gatedMean returns the mean energy of blocks above relativeLU below the
// absolute-gated mean, and the first bin admitted by that relative gate.
func (h *loudnessHistogram) gatedMean(relativeLU float64) (float64, int) {
	if h.total == 0 {
		return 0, liveHistogramN
	}
	var sum float64
	for _, e := range h.energy {
		sum += e
	}
	gate := loudness(sum/float64(h.total)) + relativeLU
	// A gate above the histogram still admits its top bin, so one absurd
	// block cannot leave integrated loudness unavailable until Reset.
	first := min(liveHistogramN-1, max(0, int(math.Ceil((gate-liveHistMinLU)*liveBinsPerLU))))
	var gated float64
	var n uint32
	for bin := first; bin < liveHistogramN; bin++ {
		gated += h.energy[bin]
		n += h.count[bin]
	}
	if n == 0 {
		return 0, liveHistogramN
	}
	return gated / float64(n), first
}

// percentile returns the bin-center loudness at fraction p of the counts at or
// above bin first.
func (h *loudnessHistogram) percentile(first int, p float64) float64 {
	var n uint32
	for bin := first; bin < liveHistogramN; bin++ {
		n += h.count[bin]
	}
	target := uint32(math.Ceil(p * float64(n)))
	target = max(target, 1)
	var seen uint32
	for bin := first; bin < liveHistogramN; bin++ {
		seen += h.count[bin]
		if seen >= target {
			return liveHistMinLU + (float64(bin)+0.5)/liveBinsPerLU
		}
	}
	return liveHistMaxLU
}

// LiveLoudness is one snapshot of a LoudnessMeter.
type LiveLoudness struct {
	MomentaryLUFS  float64 // 400 ms window (BS.1770 / EBU Tech 3341 M).
	ShortTermLUFS  float64 // 3 s window (EBU Tech 3341 S).
	IntegratedLUFS float64 // Gated BS.1770 program loudness since Reset.
	RangeLU        float64 // EBU Tech 3342 loudness range since Reset.
	TruePeakDBTP   float64 // Highest 4x-interpolated peak since Reset.
	RecentPeakDBTP float64 // Highest interpolated peak since the previous snapshot.
}

// LoudnessMeter is a streaming, allocation-free BS.1770-4 / EBU R128 meter for
// real-time playback. Momentary and short-term values update every 100 ms;
// integrated loudness gates 400 ms blocks with 75% overlap, and loudness range
// gates 3 s blocks sampled every 100 ms. Histogram bins are 0.05 LU wide.
type LoudnessMeter struct {
	shelf, highpass meterBiquad
	peak            peakInterpolator
	subLen, subPos  int
	subEnergy       float64
	ring            [liveSubBlocks]float64
	ringPos, filled int
	integrated      loudnessHistogram
	shortTerm       loudnessHistogram
	momentary       float64
	short           float64
	maxPeak         float64
	recentPeak      float64
	sampleRate      float64
}

// NewLoudnessMeter returns a meter for the given rate (8–192 kHz; others use 48 kHz).
func NewLoudnessMeter(sampleRate float64) *LoudnessMeter {
	m := &LoudnessMeter{}
	m.Init(sampleRate)
	return m
}

// Init configures the meter for a sample rate and clears all history.
func (m *LoudnessMeter) Init(sampleRate float64) {
	if !finite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 {
		sampleRate = 48000
	}
	m.sampleRate = sampleRate
	m.Reset()
}

// SampleRate returns the configured rate, or zero before Init.
func (m *LoudnessMeter) SampleRate() float64 { return m.sampleRate }

// Reset clears every window, gate histogram and peak hold.
func (m *LoudnessMeter) Reset() {
	rate := m.sampleRate
	*m = LoudnessMeter{sampleRate: rate}
	m.shelf, m.highpass = kWeighting(rate)
	m.subLen = int(math.Round(rate * 0.1))
	m.momentary, m.short = NoReading, NoReading
}

// Process measures one stereo block without allocating.
func (m *LoudnessMeter) Process(left, right []float32) {
	n := min(len(left), len(right))
	for i := range n {
		l := sanitizeSample(float64(left[i]))
		r := sanitizeSample(float64(right[i]))
		p := m.peak.sample(l, r)
		m.maxPeak = math.Max(m.maxPeak, p)
		m.recentPeak = math.Max(m.recentPeak, p)
		kl := m.highpass.sample(m.shelf.sample(l, 0), 0)
		kr := m.highpass.sample(m.shelf.sample(r, 1), 1)
		m.subEnergy += kl*kl + kr*kr
		if m.subPos++; m.subPos == m.subLen {
			m.closeSubBlock()
		}
	}
}

func (m *LoudnessMeter) closeSubBlock() {
	m.ring[m.ringPos] = m.subEnergy / float64(m.subLen)
	m.ringPos = (m.ringPos + 1) % liveSubBlocks
	m.filled = min(m.filled+1, liveSubBlocks)
	m.subEnergy, m.subPos = 0, 0
	if m.filled >= 4 {
		e := m.window(4)
		m.momentary = gatedReading(e)
		m.integrated.add(e)
	}
	if m.filled == liveSubBlocks {
		e := m.window(liveSubBlocks)
		m.short = gatedReading(e)
		m.shortTerm.add(e)
	}
}

// gatedReading reports NoReading at or below the -70 LUFS absolute gate, so
// silence shows as no reading rather than a -70 LUFS value.
func gatedReading(energy float64) float64 {
	if lu := loudness(energy); lu > liveHistMinLU {
		return lu
	}
	return NoReading
}

func (m *LoudnessMeter) window(blocks int) float64 {
	var sum float64
	for i := 1; i <= blocks; i++ {
		sum += m.ring[(m.ringPos-i+liveSubBlocks)%liveSubBlocks]
	}
	return sum / float64(blocks)
}

// Snapshot reports the current readings and restarts the recent-peak interval.
func (m *LoudnessMeter) Snapshot() LiveLoudness {
	out := LiveLoudness{
		MomentaryLUFS:  m.momentary,
		ShortTermLUFS:  m.short,
		IntegratedLUFS: NoReading,
		RangeLU:        NoReading,
		TruePeakDBTP:   linToDB(m.maxPeak),
		RecentPeakDBTP: linToDB(m.recentPeak),
	}
	m.recentPeak = 0
	if e, _ := m.integrated.gatedMean(-10); e > 0 {
		out.IntegratedLUFS = loudness(e)
	}
	if e, first := m.shortTerm.gatedMean(-20); e > 0 {
		out.RangeLU = m.shortTerm.percentile(first, 0.95) - m.shortTerm.percentile(first, 0.10)
	}
	return out
}
