package dsp

import (
	"math"
	"testing"
)

func mustStudioSaturation(t *testing.T, rate float64, amount float64, character SatCharacter) studioSaturation {
	t.Helper()
	s, err := prepareStudioSaturation(rate, SaturationParams{Enabled: true, Amount: amount, Character: character})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStudioSaturationNoDriveDelayedNullAndReset(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		s := mustStudioSaturation(t, rate, 0, SatTube)
		var prior [studioSaturationLatency][2]float64
		cursor := 0
		for frame := range 2048 {
			left, right := math.Sin(float64(frame)*.321), math.Cos(float64(frame)*.271)*.3
			l, r := s.process(left, right)
			if cursor >= len(prior) {
				cursor = 0
			}
			if math.Abs(l-prior[cursor][0]) > 1e-6 || math.Abs(r-prior[cursor][1]) > 1e-6 {
				t.Fatal("no-drive path failed exact declared-delay null")
			}
			prior[cursor][0], prior[cursor][1] = left, right
			cursor++
		}
		s.resetHistory()
		for range 512 {
			if l, r := s.process(0, 0); l != 0 || r != 0 {
				t.Fatal("saturation reset replayed old audio")
			}
		}
	}
}

func TestStudioADAAPadMeasuresWetDryPhaseAlignment(t *testing.T) {
	filter, curve := prepareStudioHalfBand(), prepareStudioTube(0)
	oversampler, adaa, pad := studioOversamplerState{}, studioADAAState{}, studioHalfSamplePad{}
	var response [512]float64
	peak, maximum := 0, 0.0
	for frame := range response {
		input := 0.0
		if frame == 0 {
			input = 1e-7
		}
		samples := oversampler.interpolate(&filter, input)
		for index, value := range samples {
			samples[index] = pad.process(adaa.process(value, curve))
		}
		response[frame] = oversampler.decimate(&filter, samples) / 1e-7
		if math.Abs(response[frame]) > maximum {
			peak, maximum = frame, math.Abs(response[frame])
		}
	}
	if peak != studioSaturationLatency {
		t.Fatalf("actual small-signal wet peak %d expected dry %d", peak, studioSaturationLatency)
	}
	for _, frequency := range []float64{.01, .1, .25, .4, .45} {
		realPart, imaginaryPart := 0.0, 0.0
		for frame, value := range response {
			angle := 2 * math.Pi * frequency * float64(frame-studioSaturationLatency)
			realPart += value * math.Cos(angle)
			imaginaryPart += value * math.Sin(angle)
		}
		if realPart <= 0 || math.Abs(imaginaryPart) > 1e-9 {
			t.Fatalf("ADAA+pad wet phase differs from delayed dry at %g", frequency)
		}
		t.Logf("small-signal wet %g cycles/base-sample: %g dB, compensated phase %g degrees", frequency, 20*math.Log10(realPart), math.Atan2(imaginaryPart, realPart)*180/math.Pi)
	}
}

func TestStudioTubeDCFiniteOverloadDriveEditsAndNoAllocations(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		s := mustStudioSaturation(t, rate, 100, SatTube)
		last := 0.0
		for range int(rate) {
			last, _ = s.process(1, 1)
		}
		if math.Abs(last) > math.Pow(10, -90.0/20) {
			t.Fatalf("rate %g residual tube DC %g", rate, last)
		}
		for _, amount := range []float64{0, 25, 100, 25, 0} {
			p := s.params
			p.Amount = amount
			if err := s.setParams(p); err != nil {
				t.Fatal(err)
			}
			for range int(rate * .01) {
				l, r := s.process(.2, -.1)
				if !finite(l) || !finite(r) || math.Abs(l) > 2 || math.Abs(r) > 2 {
					t.Fatal("drive edit created antiderivative spike")
				}
			}
		}
		for _, value := range []float64{math.MaxFloat32, math.NaN(), math.Inf(1), 0} {
			l, r := s.process(value, -value)
			if !finite(l) || !finite(r) {
				t.Fatal("tube emitted nonfinite overload")
			}
		}
		before := s
		p := s.params
		p.Amount = math.NaN()
		if s.setParams(p) == nil || s != before {
			t.Fatal("invalid drive edit changed persistent state")
		}
	}
	s := mustStudioSaturation(t, 48000, 25, SatTube)
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			s.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("saturation allocated during processing")
	}
}

func studioSpectrum(samples []float64) []complex128 {
	values := make([]complex128, len(samples))
	for i, value := range samples {
		values[i] = complex(value, 0)
	}
	for i, j := 1, 0; i < len(values); i++ {
		bit := len(values) >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for length := 2; length <= len(values); length *= 2 {
		angle := -2 * math.Pi / float64(length)
		root := complex(math.Cos(angle), math.Sin(angle))
		for start := 0; start < len(values); start += length {
			weight := complex(1, 0)
			for offset := 0; offset < length/2; offset++ {
				a, b := values[start+offset], weight*values[start+offset+length/2]
				values[start+offset], values[start+offset+length/2] = a+b, a-b
				weight *= root
			}
		}
	}
	return values
}

func studioSaturationAlias(t *testing.T, rate, amount, amplitude float64, character SatCharacter, bin int) (float64, float64) {
	t.Helper()
	const count = 8192
	s := mustStudioSaturation(t, rate, amount, character)
	warmup := max(count*2, int(rate*.5))
	for frame := range warmup {
		x := amplitude * math.Sin(2*math.Pi*float64(bin)*float64(frame)/count)
		s.process(x, x)
	}
	samples := make([]float64, count)
	for index := range samples {
		frame := warmup + index
		x := amplitude * math.Sin(2*math.Pi*float64(bin)*float64(frame)/count)
		samples[index], _ = s.process(x, x)
	}
	spectrum := studioSpectrum(samples)
	maximum := 0.0
	for index := 4; index < count/2; index++ {
		wanted := false
		for harmonic := 1; harmonic*bin < count/2; harmonic++ {
			if index >= harmonic*bin-2 && index <= harmonic*bin+2 {
				wanted = true
				break
			}
		}
		if !wanted {
			maximum = math.Max(maximum, 2*math.Hypot(real(spectrum[index]), imag(spectrum[index]))/count)
		}
	}
	fundamental := 2 * math.Hypot(real(spectrum[bin]), imag(spectrum[bin])) / count
	return 20 * math.Log10(math.Max(maximum, 1e-300)), 20 * math.Log10(math.Max(fundamental, 1e-300))
}

func TestStudioTubeNominalAliasAndPublishedHotDriveWorstCase(t *testing.T) {
	nominalWorst, hotWorst := -1000.0, -1000.0
	for _, rate := range []float64{44100, 48000} {
		for _, bin := range []int{997, 2011, 3451} {
			alias, fundamental := studioSaturationAlias(t, rate, 25, .25, SatTube, bin)
			nominalWorst = math.Max(nominalWorst, alias)
			if alias > -75 || fundamental < -15 {
				t.Fatalf("nominal rate %g bin %d alias %g fundamental %g", rate, bin, alias, fundamental)
			}
			alias, fundamental = studioSaturationAlias(t, rate, 100, 1, SatTube, bin)
			hotWorst = math.Max(hotWorst, alias)
			if !finite(alias) || !finite(fundamental) || fundamental < -20 {
				t.Fatal("hot fixture became silent or nonfinite")
			}
		}
	}
	t.Logf("Tube coherent nominal amount25/peak.25 unwanted foldback worst %g dBFS; hot amount100/peak1 worst %g dBFS", nominalWorst, hotWorst)
}

func TestStudioTubeCurveAndADAAAgainstNumericalIntegral(t *testing.T) {
	for _, amount := range []float64{0, 25, 100} {
		curve, state := prepareStudioTube(amount), studioADAAState{}
		prior := 0.0
		for _, input := range []float64{0, 1e-12, 2e-12, .0001, .5, .5 + 1e-12, -.5, -.5 + 1e-6, .1} {
			// Composite Simpson integration of the transfer is an independent
			// oracle for the antiderivative divided difference.
			average := 0.0
			for point := range 257 {
				weight := 2.0
				if point == 0 || point == 256 {
					weight = 1
				} else if point%2 == 1 {
					weight = 4
				}
				average += weight * curve.value(prior+(input-prior)*float64(point)/256)
			}
			average /= 768
			if got := state.process(input, curve); math.Abs(got-average) > 1e-6 {
				t.Fatalf("amount %g step %g..%g ADAA %g numerical %g", amount, prior, input, got, average)
			}
			prior = input
		}
		if amount == 100 && math.Abs(curve.value(.5)+curve.value(-.5)) < .01 {
			t.Fatal("tube candidate lost its explicit asymmetric transfer")
		}
	}
}

func TestStudioTubeDriveEditDoesNotInjectDividedDifferenceSpike(t *testing.T) {
	s := mustStudioSaturation(t, 48000, 25, SatTube)
	frame := 0
	for range 12000 {
		x := .2 + .01*math.Sin(2*math.Pi*.1*float64(frame))
		s.process(x, x*.5)
		frame++
	}
	for _, amount := range []float64{100, 50, 0, 25, 100} {
		p := s.params
		p.Amount = amount
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range 1000 {
			x := .2 + .01*math.Sin(2*math.Pi*.1*float64(frame))
			l, r := s.process(x, x*.5)
			frame++
			if !finite(l) || !finite(r) || math.Abs(l) > .3 || math.Abs(r) > .16 {
				t.Fatal("drive edit injected an antiderivative-history spike")
			}
		}
	}
}

func BenchmarkStudioTube48kStereo(b *testing.B) {
	s, err := prepareStudioSaturation(48000, SaturationParams{Enabled: true, Amount: 25, Character: SatTube})
	if err != nil {
		b.Fatal(err)
	}
	var input [128][2]float64
	for i := range input {
		input[i][0] = .13*math.Sin(float64(i)*.231) + .08*math.Cos(float64(i)*.119)
		input[i][1] = .11*math.Sin(float64(i)*.173) - .07*math.Cos(float64(i)*.081)
	}
	for range 32 {
		for _, pair := range input {
			s.process(pair[0], pair[1])
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		for _, pair := range input {
			s.process(pair[0], pair[1])
		}
	}
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(input)), "ns/frame")
}
