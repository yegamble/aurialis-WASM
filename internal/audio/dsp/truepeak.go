package dsp

import "math"

// True-peak lookahead geometry, in input frames. The detector output at step j
// covers t in (j-K, j-K+1] using samples [j-2K+1, j]. Holding each requirement
// for H = L+1 steps and averaging over A steps bounds the gain of every sample
// in that 2K-sample support once the signal is delayed by L = A+2K-2. A is the
// attack ramp.
const (
	truePeakAttackSeconds = 0.0015
	truePeakPhases        = 8  // oversampling ratio of the limiter detector
	truePeakHalfTaps      = 24 // K: input samples on each side of a detected point
	truePeakSupport       = 2*truePeakHalfTaps - 2
	truePeakRing          = 384 // > A+2K-1 at 192 kHz (288+47)
	truePeakKaiser        = 8.0
	// truePeakHeadroom (-0.2 dB) absorbs the detector's truncation error.
	// Against an independent 128-tap 32x reconstruction it keeps program-like
	// material with strong near-Nyquist content under the ceiling. Full-band
	// white noise, whose reconstruction depends on distant samples, can still
	// read about 0.15 dB high on such references.
	truePeakHeadroom = 0.977237221 // 10^(-0.2/20)
)

// truePeakFIR is a Kaiser-windowed sinc interpolator split into polyphase
// branches. It is deliberately stricter than the BS.1770-style 4x meter
// (peakFIR), whose 49 taps under-read content near Nyquist by more than 1 dB.
var truePeakFIR = func() [truePeakPhases][2 * truePeakHalfTaps]float64 {
	bessel := func(x float64) float64 {
		sum, term := 1.0, 1.0
		for k := 1; k < 40; k++ {
			term *= x / 2 / float64(k)
			sum += term * term
		}
		return sum
	}
	var coefficients [truePeakPhases][2 * truePeakHalfTaps]float64
	for phase := range coefficients {
		for tap := range coefficients[phase] {
			// Tap 0 is the newest sample j; phase p evaluates t = j-K+1-p/M.
			distance := float64(truePeakHalfTaps-1-tap) + float64(phase)/truePeakPhases
			sinc := 1.0
			if distance != 0 {
				sinc = math.Sin(math.Pi*distance) / (math.Pi * distance)
			}
			w := distance / float64(truePeakHalfTaps)
			window := 0.0
			if math.Abs(w) < 1 {
				window = bessel(truePeakKaiser*math.Sqrt(1-w*w)) / bessel(truePeakKaiser)
			}
			coefficients[phase][tap] = sinc * window
		}
	}
	return coefficients
}()

// truePeakDetector returns the linked stereo peak of the reconstructed signal.
type truePeakDetector struct {
	history [2][2 * truePeakHalfTaps]float64
	cursor  int
}

func (d *truePeakDetector) sample(left, right float64) float64 {
	const taps = 2 * truePeakHalfTaps
	d.history[0][d.cursor], d.history[1][d.cursor] = left, right
	peak := 0.0
	for phase := range truePeakFIR {
		var l, r float64
		index := d.cursor
		for _, coefficient := range truePeakFIR[phase] {
			l += coefficient * d.history[0][index]
			r += coefficient * d.history[1][index]
			if index == 0 {
				index = taps
			}
			index--
		}
		peak = math.Max(peak, math.Max(math.Abs(l), math.Abs(r)))
	}
	d.cursor = (d.cursor + 1) % taps
	return peak
}

// truePeakLimiter is the algorithm v2 lookahead limiter. Requirements come
// from truePeakFIR against the ceiling lowered by truePeakHeadroom.
type truePeakLimiter struct {
	attack, latency, hold int

	detector truePeakDetector

	// Delay line: processed L/R and raw L/R for A/B monitoring and bypass.
	delay  [4][truePeakRing]float64
	cursor int
	// Frames Drain still owes: the full latency after any input, else zero.
	pending int

	// Monotonic min-hold queue over the last H requirements.
	minValue [truePeakRing]float64
	minStep  [truePeakRing]int
	minHead  int
	minLen   int
	step     int

	// Release envelope and A-step moving average of it.
	envelope   float64
	average    [truePeakRing]float64
	averageSum float64
	averageAt  int
}

func newTruePeakLimiter(sampleRate float64) truePeakLimiter {
	attack := max(1, int(math.Round(sampleRate*truePeakAttackSeconds)))
	t := truePeakLimiter{attack: attack, latency: attack + truePeakSupport, hold: attack + truePeakSupport + 1}
	t.reset()
	return t
}

func (t *truePeakLimiter) reset() {
	attack, latency, hold := t.attack, t.latency, t.hold
	*t = truePeakLimiter{attack: attack, latency: latency, hold: hold, envelope: 1}
	for i := 0; i < attack; i++ {
		t.average[i] = 1
	}
	t.averageSum = float64(attack)
}

// requirement returns the linked gain needed so the reconstruction around the
// sample entering the detector now stays at or below ceiling.
func (t *truePeakLimiter) requirement(l, r, ceiling float64, limit bool) float64 {
	peak := t.detector.sample(l, r)
	if !limit || peak <= ceiling || peak < 1e-12 {
		return 1
	}
	return ceiling / peak
}

// gain advances the min-hold, release, and moving-average stages by one step.
func (t *truePeakLimiter) gain(required, release float64) float64 {
	for t.minLen > 0 && t.minValue[(t.minHead+t.minLen-1)%truePeakRing] >= required {
		t.minLen--
	}
	tail := (t.minHead + t.minLen) % truePeakRing
	t.minValue[tail], t.minStep[tail] = required, t.step
	t.minLen++
	if t.minStep[t.minHead] <= t.step-t.hold {
		t.minHead = (t.minHead + 1) % truePeakRing
		t.minLen--
	}
	t.step++
	held := t.minValue[t.minHead]

	if held < t.envelope {
		t.envelope = held
	} else {
		t.envelope = held + (t.envelope-held)*release
	}

	t.averageSum += t.envelope - t.average[t.averageAt]
	t.average[t.averageAt] = t.envelope
	t.averageAt++
	if t.averageAt == t.attack {
		// Recompute once per window so running-sum rounding cannot accumulate.
		t.averageAt, t.averageSum = 0, 0
		for i := 0; i < t.attack; i++ {
			t.averageSum += t.average[i]
		}
	}
	return math.Min(1, t.averageSum/float64(t.attack))
}

// push stores one frame and returns the frame delayed by latency steps.
func (t *truePeakLimiter) push(l, r, rawL, rawR float64) (float64, float64, float64, float64) {
	at := t.cursor
	dl, dr, drl, drr := t.delay[0][at], t.delay[1][at], t.delay[2][at], t.delay[3][at]
	t.delay[0][at], t.delay[1][at], t.delay[2][at], t.delay[3][at] = l, r, rawL, rawR
	t.cursor = (t.cursor + 1) % t.latency
	return dl, dr, drl, drr
}

// process advances the limiter by one frame and returns the delayed frame with
// its gain. With limit false it runs at unity gain so state stays aligned.
func (t *truePeakLimiter) process(l, r, rawL, rawR, ceiling, release float64, limit bool) (float64, float64, float64, float64, float64) {
	gain := t.gain(t.requirement(l, r, ceiling*truePeakHeadroom, limit), release)
	l, r, rawL, rawR = t.push(l, r, rawL, rawR)
	if !limit {
		return l, r, rawL, rawR, 1
	}
	return l * gain, r * gain, rawL, rawR, gain
}
