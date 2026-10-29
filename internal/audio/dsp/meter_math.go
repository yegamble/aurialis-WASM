package dsp

import "math"

type meterBiquad struct {
	b0, b1, b2, a1, a2 float64
	z1, z2             [2]float64
}

func (b *meterBiquad) sample(x float64, channel int) float64 {
	y := b.b0*x + b.z1[channel]
	b.z1[channel] = sanitizeSample(b.b1*x - b.a1*y + b.z2[channel])
	b.z2[channel] = sanitizeSample(b.b2*x - b.a2*y)
	return y
}

// kWeighting uses the De Man sample-rate transform of the BS.1770 shelf and
// RLB high-pass. It is intentionally independent of the creative EQ filters.
// Reference equations: https://github.com/jiixyj/libebur128 (ebur128_init_filter).
func kWeighting(rate float64) (meterBiquad, meterBiquad) {
	k := math.Tan(math.Pi * 1681.974450955533 / rate)
	q := 0.7071752369554196
	vh := math.Pow(10, 3.999843853973347/20)
	vb := math.Pow(vh, 0.4996667741545416)
	a0 := 1 + k/q + k*k
	shelf := meterBiquad{
		b0: (vh + vb*k/q + k*k) / a0, b1: 2 * (k*k - vh) / a0, b2: (vh - vb*k/q + k*k) / a0,
		a1: 2 * (k*k - 1) / a0, a2: (1 - k/q + k*k) / a0,
	}
	k = math.Tan(math.Pi * 38.13547087602444 / rate)
	q = 0.5003270373238773
	a0 = 1 + k/q + k*k
	// The RLB numerator is [1,-2,1], without normalizing it by a0.
	highpass := meterBiquad{b0: 1, b1: -2, b2: 1, a1: 2 * (k*k - 1) / a0, a2: (1 - k/q + k*k) / a0}
	return shelf, highpass
}

func loudness(energy float64) float64 {
	if energy <= 0 {
		return -70
	}
	return math.Max(-70, -0.691+10*math.Log10(energy))
}
func gatedLoudness(blocks []float64) float64 {
	absolute := math.Pow(10, (-70+0.691)/10)
	var sum float64
	var count int
	for _, energy := range blocks {
		if energy > absolute {
			sum += energy
			count++
		}
	}
	if count == 0 {
		return -70
	}
	relative := math.Max(absolute, sum/float64(count)*0.1)
	sum, count = 0, 0
	for _, energy := range blocks {
		if energy > relative {
			sum += energy
			count++
		}
	}
	if count == 0 {
		return -70
	}
	return loudness(sum / float64(count))
}

// True-peak meter geometry. A 4x Kaiser-windowed sinc (48 taps per phase,
// beta 7) is accurate to 0.05% up to 0.45 fs and 1% at 0.46 fs, where the
// 49-tap 4x design of BS.1770-4 Annex 2 under-read near-Nyquist content by
// more than 1 dB (V1-13). A parabola through the largest grid value and its
// neighbors then refines the peak between grid points: a sine's grid error
// falls from 0.69 dB at Nyquist to 0.07 dB, and to 0.05 dB at 0.46 fs. The
// parabola under-reads a sine, so refinement does not inflate the reading.
const (
	peakPhases   = 4
	peakHalfTaps = 24 // input samples on each side of an interpolated point
	peakKaiser   = 7.0
)

// peakFIR holds phases 1..3 in window order (index 0 is the oldest of the 2K
// samples); phase 0 lands on a sample and is the sample.
var peakFIR = func() [peakPhases - 1][2 * peakHalfTaps]float64 {
	var coefficients [peakPhases - 1][2 * peakHalfTaps]float64
	for phase := range coefficients {
		for i := range coefficients[phase] {
			// Window index i holds sample j-2K+1+i; phase p+1 evaluates
			// t = j-K+1-(p+1)/M.
			distance := float64(i-peakHalfTaps) + float64(phase+1)/peakPhases
			w := distance / peakHalfTaps
			window := 0.0
			if math.Abs(w) < 1 {
				window = besselI0(peakKaiser*math.Sqrt(1-w*w)) / besselI0(peakKaiser)
			}
			coefficients[phase][i] = math.Sin(math.Pi*distance) / (math.Pi * distance) * window
		}
	}
	return coefficients
}()

// peakInterpolator is the live LoudnessMeter's streaming true-peak display.
// Its readings lag the input by K-1 samples. It is held to 0.1 dB on what the
// export limiter emits; content above 0.46 fs (an unlimited source) reads low
// on it, and the export meter (offlineMonitorTruePeak) covers that. As in
// truePeakDetector, each sample is stored twice so the window is contiguous.
type peakInterpolator struct {
	history [2][4 * peakHalfTaps]float64
	cursor  int
	// The two previous grid values per channel, oldest first.
	grid [2][2]float64
}

func (p *peakInterpolator) sample(left, right float64) float64 {
	const taps = 2 * peakHalfTaps
	p.history[0][p.cursor], p.history[1][p.cursor] = left, right
	p.history[0][p.cursor+taps], p.history[1][p.cursor+taps] = left, right
	windowL := (*[taps]float64)(p.history[0][p.cursor+1 : p.cursor+1+taps])
	windowR := (*[taps]float64)(p.history[1][p.cursor+1 : p.cursor+1+taps])
	p.cursor = (p.cursor + 1) % taps
	// Grid values in time order: t = j-K+1-3/4, -2/4, -1/4, then the sample.
	var valuesL, valuesR [peakPhases]float64
	for phase := range peakFIR {
		coefficients := &peakFIR[phase]
		var l, r float64
		for i, coefficient := range coefficients {
			l += coefficient * windowL[i]
			r += coefficient * windowR[i]
		}
		valuesL[peakPhases-2-phase], valuesR[peakPhases-2-phase] = l, r
	}
	valuesL[peakPhases-1], valuesR[peakPhases-1] = windowL[peakHalfTaps], windowR[peakHalfTaps]
	peak := 0.0
	for channel, values := range [2]*[peakPhases]float64{&valuesL, &valuesR} {
		grid := &p.grid[channel]
		for _, value := range values {
			peak = math.Max(peak, refinePeak(grid[0], grid[1], value))
			grid[0], grid[1] = grid[1], value
		}
	}
	return peak
}

// refinePeak returns |b|, or the vertex of the parabola through a, b, c when
// b is a local maximum of the magnitude.
func refinePeak(a, b, c float64) float64 {
	magnitude := math.Abs(b)
	if magnitude < math.Abs(a) || magnitude < math.Abs(c) {
		return magnitude
	}
	if b < 0 {
		a, b, c = -a, -b, -c
	}
	curvature := a - 2*b + c
	if curvature >= 0 {
		return magnitude
	}
	return b - (a-c)*(a-c)/(8*curvature)
}
