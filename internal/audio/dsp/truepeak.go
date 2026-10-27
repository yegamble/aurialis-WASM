package dsp

import "math"

// True-peak lookahead geometry, in input frames. The detector output at step j
// covers t in (j-K, j-K+1] using samples [j-2K+1, j]. Holding each requirement
// for H = L+1 steps and averaging over A steps bounds the gain of every sample
// in that 2K-sample support once the signal is delayed by L = A+2K-2. A is the
// attack ramp.
const (
	truePeakAttackSeconds = 0.0015
	// guardFadeSeconds crossfades guarded and unguarded audio when limiting
	// is switched live, so the switch leaves no splice.
	guardFadeSeconds = 0.005
	truePeakPhases   = 8  // oversampling ratio of the limiter detector
	truePeakHalfTaps = 24 // K: input samples on each side of a detected point
	truePeakSupport  = 2*truePeakHalfTaps - 2
	truePeakRing     = 384 // > A+2K-1 at 192 kHz (288+47)
	truePeakKaiser   = 8.0
	// truePeakHeadroom (-0.2 dB) absorbs the detector's remaining error on
	// guarded input (nyquistGuard): the 8-phase grid can miss a 0.45 fs peak
	// by 0.14 dB, and gain changes inside the 48-sample support move the
	// reconstruction a little. Against the long-sinc reference
	// (internal/audio/truepeakref) limited exports sit 0.18-0.23 dB under the ceiling.
	truePeakHeadroom = 0.977237221 // 10^(-0.2/20)
)

// besselI0 is the zeroth-order modified Bessel function of the first kind for
// the Kaiser windows of the true-peak detector and the export resampler. Forty
// series terms converge to double precision for arguments up to about 13,
// beyond either window's beta.
func besselI0(x float64) float64 {
	sum, term := 1.0, 1.0
	for k := 1; k < 40; k++ {
		term *= x / 2 / float64(k)
		sum += term * term
	}
	return sum
}

// truePeakFIR is a Kaiser-windowed sinc interpolator split into polyphase
// branches, accurate to 0.14% up to 0.45 fs: the band nyquistGuard passes.
var truePeakFIR = func() [truePeakPhases][2 * truePeakHalfTaps]float64 {
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
				window = besselI0(truePeakKaiser*math.Sqrt(1-w*w)) / besselI0(truePeakKaiser)
			}
			coefficients[phase][tap] = sinc * window
		}
	}
	return coefficients
}()

// truePeakDetector returns the linked stereo peak of the reconstructed signal.
// Each sample is stored twice, one window apart, so the newest 2K samples are
// always contiguous: the live worklet runs this FIR for every frame, and a
// wrap test per tap cost about a fifth of the limiter in WASM. The products
// are summed in the same order as a ring walk, so output is bit-identical.
type truePeakDetector struct {
	history [2][4 * truePeakHalfTaps]float64
	cursor  int
}

func (d *truePeakDetector) sample(left, right float64) float64 {
	const taps = 2 * truePeakHalfTaps
	d.history[0][d.cursor], d.history[1][d.cursor] = left, right
	d.history[0][d.cursor+taps], d.history[1][d.cursor+taps] = left, right
	// window[taps-1] is the newest sample and window[0] the oldest.
	windowL := (*[taps]float64)(d.history[0][d.cursor+1 : d.cursor+1+taps])
	windowR := (*[taps]float64)(d.history[1][d.cursor+1 : d.cursor+1+taps])
	peak := 0.0
	for phase := range truePeakFIR {
		coefficients := &truePeakFIR[phase]
		var l, r float64
		for tap := 0; tap < taps; tap++ {
			coefficient := coefficients[tap]
			l += coefficient * windowL[taps-1-tap]
			r += coefficient * windowR[taps-1-tap]
		}
		peak = math.Max(peak, math.Max(math.Abs(l), math.Abs(r)))
	}
	d.cursor = (d.cursor + 1) % taps
	return peak
}

// nyquistGuardSections is an 8th-order elliptic low-pass in second-order
// sections {b0, b1, b2, a1, a2}: flat to 0.45 fs (0 to +0.01 dB, unity at
// DC) and at least 70 dB down from 0.464 fs. It is specified in normalized
// frequency, so one set serves every rate: 19.8 kHz passband at 44.1 kHz,
// 21.6 kHz at 48 kHz. truePeakFIR is accurate to 0.14% up to 0.45 fs but
// under-reads by 10% at 0.47 fs and 60% at 0.49 fs, so content in the top of
// the band reached the ideal reconstruction up to 1.5 dB over the ceiling
// (V1-13). Removing it before detection makes the detector's accuracy hold
// for whatever the chain feeds the limiter. Generated with SciPy:
// signal.ellip(8, 0.01, 70, 0.9, output="sos"), first section scaled to
// unity DC gain.
var nyquistGuardSections = [4][5]float64{
	{0.4968144773977866, 0.9922982910215842, 0.4968144773977866, 1.2471523769477268, 0.4110340455309755},
	{1.0, 1.9803737009470235, 0.9999999999999999, 1.5875708316789159, 0.7062029271152792},
	{1.0, 1.961551365591217, 0.9999999999999996, 1.7880336638312146, 0.8815601061724416},
	{1.0, 1.9510488053838244, 1.0000000000000002, 1.8827813685844075, 0.9681668373460819},
}

// nyquistGuard runs nyquistGuardSections on both channels in transposed
// direct form II.
type nyquistGuard struct {
	state [len(nyquistGuardSections)][2][2]float64 // section, channel, z1/z2
}

func (g *nyquistGuard) sample(left, right float64) (float64, float64) {
	for i := range nyquistGuardSections {
		c := &nyquistGuardSections[i]
		s := &g.state[i]
		y := c[0]*left + s[0][0]
		s[0][0] = sanitizeSample(c[1]*left - c[3]*y + s[0][1])
		s[0][1] = sanitizeSample(c[2]*left - c[4]*y)
		left = y
		y = c[0]*right + s[1][0]
		s[1][0] = sanitizeSample(c[1]*right - c[3]*y + s[1][1])
		s[1][1] = sanitizeSample(c[2]*right - c[4]*y)
		right = y
	}
	return left, right
}

// truePeakLimiter is the algorithm v2 lookahead limiter. While limiting it
// band-limits its input with nyquistGuard, then takes requirements from
// truePeakFIR against the ceiling lowered by truePeakHeadroom.
type truePeakLimiter struct {
	attack, latency, hold int

	guard    nyquistGuard
	detector truePeakDetector
	// guardMix crossfades unguarded (0) and guarded (1) input when limiting
	// starts or stops, guardStep per frame over guardFadeSeconds. The first
	// frame after a reset takes the target at once, so a render whose
	// settings never change is never faded. guardStale marks a guard that
	// ran on bypassed audio; processing restarts it from silence instead.
	guardMix, guardStep     float64
	guardPrimed, guardStale bool

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
	t := truePeakLimiter{attack: attack, latency: attack + truePeakSupport, hold: attack + truePeakSupport + 1,
		guardStep: 1 / math.Max(1, math.Round(sampleRate*guardFadeSeconds))}
	t.reset()
	return t
}

func (t *truePeakLimiter) reset() {
	attack, latency, hold, step := t.attack, t.latency, t.hold, t.guardStep
	*t = truePeakLimiter{attack: attack, latency: latency, hold: hold, guardStep: step, envelope: 1}
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
// its gain. With limit false it runs at unity gain on the unfiltered frame;
// the guard still runs so its state is current when limiting resumes, and a
// change of limit crossfades the two over guardFadeSeconds.
func (t *truePeakLimiter) process(l, r, rawL, rawR, ceiling, release float64, limit bool) (float64, float64, float64, float64, float64) {
	guardL, guardR := t.guard.sample(l, r)
	target := 0.0
	if limit {
		target = 1
	}
	if !t.guardPrimed {
		t.guardMix, t.guardPrimed = target, true
	}
	if t.guardMix < target {
		t.guardMix = math.Min(target, t.guardMix+t.guardStep)
	} else if t.guardMix > target {
		t.guardMix = math.Max(target, t.guardMix-t.guardStep)
	}
	switch t.guardMix {
	case 1:
		l, r = guardL, guardR
	case 0:
	default:
		// A raised-cosine ramp leaves less splice energy than a linear one.
		weight := 0.5 - 0.5*math.Cos(math.Pi*t.guardMix)
		l += weight * (guardL - l)
		r += weight * (guardR - r)
	}
	gain := t.gain(t.requirement(l, r, ceiling*truePeakHeadroom, limit), release)
	l, r, rawL, rawR = t.push(l, r, rawL, rawR)
	if !limit {
		return l, r, rawL, rawR, 1
	}
	return l * gain, r * gain, rawL, rawR, gain
}
