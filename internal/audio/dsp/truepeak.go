package dsp

import "math"

// True-peak lookahead geometry, in input frames. The detector reuses the
// metering peakFIR, whose output at step j reconstructs t in [j-6, j-5) from
// samples [j-12, j]. Holding each requirement for H = A+12 steps and averaging
// over A steps bounds the gain of every sample in that support once the signal
// is delayed by L = A+11. A is the attack ramp.
const (
	truePeakAttackSeconds = 0.0015
	truePeakSupport       = 11
	truePeakRing          = 320 // > A+12 at 192 kHz (288+12)
)

// truePeakLimiter is the algorithm v2 lookahead limiter. Requirements come from
// the same 4x windowed-sinc reconstruction used by MeasureStereo, so the output
// is limited against the meter's own definition of a true peak.
type truePeakLimiter struct {
	attack, latency, hold int

	detector peakInterpolator

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
