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

// Hann-windowed sinc interpolation: 49 taps at 4x, divided into four polyphase
// branches. This matches the public libebur128 interpolation design. A finite FIR
// remains an estimate rather than a guarantee for every band-limited waveform.
var peakFIR = func() [4][13]float64 {
	var coefficients [4][13]float64
	for tap := 0; tap < 49; tap++ {
		distance := float64(tap-24) / 4
		sinc := 1.0
		if distance != 0 {
			sinc = math.Sin(math.Pi*distance) / (math.Pi * distance)
		}
		coefficients[tap%4][tap/4] = sinc * 0.5 * (1 - math.Cos(2*math.Pi*float64(tap)/48))
	}
	return coefficients
}()

type peakInterpolator struct {
	history [2][13]float64
	cursor  int
}

func (p *peakInterpolator) sample(left, right float64) float64 {
	p.history[0][p.cursor], p.history[1][p.cursor] = left, right
	peak := math.Max(math.Abs(left), math.Abs(right))
	for phase := 0; phase < 4; phase++ {
		var l, r float64
		for tap, coefficient := range peakFIR[phase] {
			index := (p.cursor - tap + 13) % 13
			l += coefficient * p.history[0][index]
			r += coefficient * p.history[1][index]
		}
		peak = math.Max(peak, math.Max(math.Abs(l), math.Abs(r)))
	}
	p.cursor = (p.cursor + 1) % 13
	return peak
}
