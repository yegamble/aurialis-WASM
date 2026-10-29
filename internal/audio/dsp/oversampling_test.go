package dsp

import (
	"fmt"
	"math"
	"testing"
)

func halfBandCoefficients() [129]float64 {
	var h [129]float64
	h[64] = .5
	for i, c := range halfBandOdd {
		h[2*i+1], h[127-2*i] = c, c
	}
	return h
}

func TestOversamplingFIRHasDesignedStopband(t *testing.T) {
	h := halfBandCoefficients()
	passError, stop := 0.0, 0.0
	derivativeBound := 0.0
	for n, c := range h {
		derivativeBound += 2 * math.Pi * math.Abs(float64(n-64)*c)
	}
	for k := 0; k <= 32768; k++ {
		f := .5 * float64(k) / 32768
		response := 0.0
		for n, c := range h {
			response += c * math.Cos(2*math.Pi*f*float64(n-64))
		}
		if f <= .2275 {
			passError = math.Max(passError, math.Abs(response-1))
		}
		if f >= .2725 {
			stop = math.Max(stop, math.Abs(response))
		}
	}
	t.Logf("FIR pass error %.6g; maximum stopband %.3f dB", passError, 20*math.Log10(stop))
	// The derivative bound also covers frequencies between grid points,
	// including the first partial grid interval at the stopband boundary.
	continuousStopBound := stop + derivativeBound*(.5/32768)
	t.Logf("continuous stopband conservative bound %.3f dB", 20*math.Log10(continuousStopBound))
	if passError > 1e-4 || continuousStopBound > 1e-3 {
		t.Fatalf("pass error %g, stopband %g", passError, stop)
	}
}

func TestPolyphaseMatchesIndependentDirectConvolution(t *testing.T) {
	h := halfBandCoefficients()
	var up halfBandInterpolator
	var down halfBandDecimator
	var input, high, filtered [600]float64
	for i := 0; i < 150; i++ {
		input[2*i] = math.Sin(float64(i)*.673) * .7
	}
	for n := range high {
		for k, c := range h {
			if n >= k {
				high[n] += 2 * c * input[n-k]
			}
		}
	}
	for n := range filtered {
		for k, c := range h {
			if n >= k {
				filtered[n] += c * high[n-k]
			}
		}
	}
	for n := 0; n < 300; n++ {
		a, b := up.process(input[2*n])
		if math.Abs(a-high[2*n]) > 1e-14 || math.Abs(b-high[2*n+1]) > 1e-14 {
			t.Fatalf("interpolation frame %d", n)
		}
		if got := down.process(a, b); math.Abs(got-filtered[2*n]) > 1e-14 {
			t.Fatalf("decimation frame %d: %g != %g", n, got, filtered[2*n])
		}
	}
	var impulseUp halfBandInterpolator
	var impulseDown halfBandDecimator
	peak, at := 0.0, 0
	for n := 0; n < 180; n++ {
		input := 0.0
		if n == 0 {
			input = 1
		}
		a, b := impulseUp.process(input)
		v := impulseDown.process(a, b)
		if math.Abs(v) > peak {
			peak, at = math.Abs(v), n
		}
	}
	if at != saturationLatency {
		t.Fatalf("delay %d, want %d", at, saturationLatency)
	}
}

func TestOversampledNeutralAndBypassKeepFixedDelayAndSource(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, bypass := range []bool{false, true} {
			p := DefaultParams()
			p.AlgorithmVersion = OversampledAlgorithmVersion
			p.Bypass = bypass
			if bypass {
				p.InputGainDB = 18
				p.Saturation = SaturationParams{Enabled: true, Character: SatTube, Amount: 100}
			}
			e := NewEngine(rate)
			e.SetParams(p)
			if e.LatencyFrames() != int(math.Round(rate*.0015))+46+64 {
				t.Fatal("incorrect fixed latency")
			}
			for _, frames := range []int{1, 127, 128, 129, 4096} {
				e.Reset()
				left, right := make([]float32, frames), make([]float32, frames)
				for i := range left {
					left[i], right[i] = float32(i%31-15)/16, float32(i%17-8)/16
				}
				outL, outR, err := RenderLatencyCompensated(e, frames, func(l, r []float32) error { e.ProcessBlock(left, right, l, r); return nil })
				if err != nil {
					t.Fatal(err)
				}
				for i := range left {
					if outL[i] != left[i] || outR[i] != right[i] {
						t.Fatalf("rate %g bypass %t frames %d sample %d: %g != %g", rate, bypass, frames, i, outL[i], left[i])
					}
				}
				if e.Drain(outL, outR) != 0 {
					t.Fatal("drain replayed tail")
				}
			}
		}
	}
}

func TestOversampledWidthAutomationUsesItsSourceFrame(t *testing.T) {
	const frames = 513
	p := DefaultParams()
	p.AlgorithmVersion = OversampledAlgorithmVersion
	p.Stereo.Enabled = true
	e := NewEngine(48000)
	e.SetParams(p)
	left, right := make([]float32, frames), make([]float32, frames)
	width := make([]float64, frames)
	for i := range left {
		left[i], right[i] = .25, -.25
		width[i] = float64(i % 201)
	}
	outL, outR, err := RenderLatencyCompensated(e, frames, func(l, r []float32) error {
		for start := 0; start < frames; start += 127 {
			end := min(start+127, frames)
			if !e.ProcessAutomationBlock(left[start:end], right[start:end], l[start:end], r[start:end], nil, width[start:end]) {
				t.Fatal("lane rejected")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := range left {
		want := float32(.25 * width[i] / 100)
		if outL[i] != want || outR[i] != -want {
			t.Fatalf("source frame %d: %g/%g want ±%g", i, outL[i], outR[i], want)
		}
	}
}

func TestOversampledDetachedDrainRestoresAllRunningState(t *testing.T) {
	p := DefaultParams()
	p.AlgorithmVersion = OversampledAlgorithmVersion
	p.Saturation = SaturationParams{Enabled: true, Character: SatTape, Amount: 70}
	p.Stereo.Enabled, p.Stereo.MonoBass = true, true
	p.Limiter.Enabled = true
	a, b := NewEngine(48000), NewEngine(48000)
	a.SetParams(p)
	b.SetParams(p)
	var input, outL, outR, wantL, wantR [129]float32
	for i := range input {
		input[i] = float32(math.Sin(float64(i)*.79) * .8)
	}
	for range 5 {
		a.ProcessBlock(input[:], input[:], outL[:], outR[:])
		b.ProcessBlock(input[:], input[:], wantL[:], wantR[:])
	}
	var tailL, tailR [512]float32
	if n := a.DrainDetached(tailL[:], tailR[:]); n != a.LatencyFrames() {
		t.Fatalf("drained %d", n)
	}
	for range 4 {
		a.ProcessBlock(input[:], input[:], outL[:], outR[:])
		b.ProcessBlock(input[:], input[:], wantL[:], wantR[:])
		if outL != wantL || outR != wantR {
			t.Fatal("detached drain changed continuation")
		}
	}
	a.Reset()
	b.Reset()
	a.ProcessBlock(input[:], input[:], outL[:], outR[:])
	b.ProcessBlock(input[:], input[:], wantL[:], wantR[:])
	n := a.Drain(tailL[:3], tailR[:3])
	n += a.Drain(tailL[n:], tailR[n:])
	var wholeL, wholeR [512]float32
	m := b.Drain(wholeL[:], wholeR[:])
	if n != m || tailL != wholeL || tailR != wholeR {
		t.Fatal("partial drain differs from whole drain")
	}
}

func TestOversampledRenderAllocatesNoBlocks(t *testing.T) {
	for _, size := range []int{1, 127, 128, 129, 4096} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			p := DefaultParams()
			p.AlgorithmVersion = OversampledAlgorithmVersion
			p.Saturation = SaturationParams{Enabled: true, Character: SatTube, Amount: 60}
			p.Limiter.Enabled = true
			e := NewEngine(48000)
			e.SetParams(p)
			in, out := make([]float32, size), make([]float32, size)
			var tailL, tailR [512]float32
			if n := testing.AllocsPerRun(10, func() { e.ProcessBlock(in, in, out, out); e.DrainDetached(tailL[:], tailR[:]) }); n != 0 {
				t.Fatalf("%g allocations", n)
			}
		})
	}
}

func TestOversampledSaturationSelectedAlias(t *testing.T) {
	const count = 32768
	for _, rate := range []float64{44100, 48000} {
		for _, character := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatTube, SatTape, SatTransformer} {
			for _, amount := range []float64{10, 50, 100} {
				p := DefaultParams()
				p.AlgorithmVersion = OversampledAlgorithmVersion
				p.Saturation = SaturationParams{Enabled: true, Character: character, Amount: amount}
				e := NewEngine(rate)
				e.SetParams(p)
				input := make([]float32, 2*count)
				f := rate * 7001 / count
				for i := range input {
					input[i] = float32(.5 * math.Sin(2*math.Pi*7001*float64(i)/count))
				}
				out, _, err := RenderLatencyCompensated(e, len(input), func(l, r []float32) error { e.ProcessBlock(input, input, l, r); return nil })
				if err != nil {
					t.Fatal(err)
				}
				alias := GoertzelMagnitudeDB(out[count:], rate, rate-3*f)
				t.Logf("rate %.0f %s drive %.0f: selected folded third %.2f dBFS", rate, character, amount, alias)
				if alias > -65 {
					t.Errorf("selected alias %.2f dBFS exceeds -65 dBFS", alias)
				}
			}
		}
	}
}

func TestOversampledStereoLR4Reconstruction(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, frequency := range []float64{60, 110, 250} {
			c := computeButterworthSVF(rate, frequency)
			var low, high [2]svfState
			var sumSin, sumCos, loSin, loCos, hiSin, hiCos float64
			count := int(rate)
			for i := 0; i < 2*count; i++ {
				phase := 2 * math.Pi * frequency * float64(i) / rate
				x := math.Sin(phase)
				l, h := linkwitzRiley(c, &low, x, true), linkwitzRiley(c, &high, x, false)
				if i < count {
					continue
				}
				loSin += l * math.Sin(phase)
				loCos += l * math.Cos(phase)
				hiSin += h * math.Sin(phase)
				hiCos += h * math.Cos(phase)
				sumSin += (l + h) * math.Sin(phase)
				sumCos += (l + h) * math.Cos(phase)
			}
			amp := func(s, c float64) float64 { return 20 * math.Log10(2*math.Hypot(s, c)/float64(count)) }
			phase := math.Abs(math.Remainder(math.Atan2(loCos, loSin)-math.Atan2(hiCos, hiSin), 2*math.Pi)) * 180 / math.Pi
			if math.Abs(amp(loSin, loCos)+6.0206) > .1 || math.Abs(amp(hiSin, hiCos)+6.0206) > .1 || math.Abs(amp(sumSin, sumCos)) > .01 || phase > 1 {
				t.Fatalf("%g/%g LR4 magnitude/phase failure", rate, frequency)
			}
			p := DefaultParams()
			p.AlgorithmVersion = 3
			p.Stereo.Enabled = true
			p.Stereo.MonoBass = true
			p.Stereo.WidthPct = 0
			p.Stereo.CrossoverHz = frequency
			e := NewEngine(rate)
			e.SetParams(p)
			control := e.oversampledControls(0)
			for i := 0; i < 1000; i++ {
				l, r := e.oversampledStereo(math.Sin(float64(i)), math.Cos(float64(i)*.7), control)
				if math.Abs(l-r) > 1e-6 {
					t.Fatal("width zero is not mono")
				}
			}
		}
	}
}
