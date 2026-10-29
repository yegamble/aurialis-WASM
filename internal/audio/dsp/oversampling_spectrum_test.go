package dsp

import (
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/fft"
)

func TestCenteredADAAMatchesIndependentCurveIntegration(t *testing.T) {
	for _, character := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatTube, SatTape, SatTransformer} {
		for _, amount := range []float64{.1, .5, 1} {
			c := oversampledControls{saturation: SaturationParams{Character: character}, amount: amount, drive: 1 + 3.2*amount}
			for _, ends := range []struct{ first, last float64 }{{-.9, .8}, {.3, .30000001}, {-.0001, .0001}, {-.1, .1}, {1.49, 1.51}, {-8, 9}, {10, 11}, {.11, .10}} {
				value := func(x float64) float64 {
					if character == SatWarm {
						v, _ := adaaWarmWave(x, c.drive)
						return v
					}
					drive, bias := c.drive, 0.0
					if character == SatCrisp {
						drive *= 1.1
					}
					if character == SatTube || character == SatTape || character == SatTransformer {
						drive = 1 + 3*amount
					}
					if character == SatTube {
						bias = .12
					}
					b := math.Tanh(bias)
					return (math.Tanh(drive*x+bias) - b) / (drive * (1 - b*b))
				}
				const steps = 4096
				sum := value(ends.first) + value(ends.last)
				for k := 1; k < steps; k++ {
					weight := 2.0
					if k%2 != 0 {
						weight = 4
					}
					sum += weight * value(ends.first+(ends.last-ends.first)*float64(k)/steps)
				}
				want := sum / (3 * steps)
				got := oversampledADAA(ends.first, ends.last, c)
				if !finite(got) || math.Abs(got-want) > 3e-7 {
					t.Fatalf("%s drive %g %v: %g != integral %g", character, amount, ends, got, want)
				}
			}
		}
	}
}

// toneAlias excludes true in-band harmonics before finding the largest other
// FFT component. The middle coherent window excludes startup and EOF effects.
func toneAlias(t *testing.T, plan fft.Plan, rate float64, character SatCharacter, amplitude float64, bin int, version uint32) (float64, float64, int) {
	t.Helper()
	const count = 16384
	p := DefaultParams()
	p.AlgorithmVersion = version
	p.Saturation = SaturationParams{Enabled: true, Character: character, Amount: 100}
	engine := NewEngine(rate)
	engine.SetParams(p)
	input := make([]float32, 3*count)
	for i := range input {
		input[i] = float32(amplitude * math.Sin(2*math.Pi*float64(bin*i)/count))
	}
	output, _, err := RenderLatencyCompensated(engine, len(input), func(l, r []float32) error { engine.ProcessBlock(input, input, l, r); return nil })
	if err != nil {
		t.Fatal(err)
	}
	spectrum := make([]complex128, count)
	for i := range spectrum {
		spectrum[i] = complex(float64(output[count+i]), 0)
	}
	plan.Transform(spectrum, false)
	peak, peakBin := 0.0, 0
	for k := 2; k < count/2; k++ {
		harmonic := false
		for order := 1; order*bin < count/2; order++ {
			if distance := k - order*bin; distance >= -1 && distance <= 1 {
				harmonic = true
			}
		}
		if harmonic {
			continue
		}
		power := real(spectrum[k])*real(spectrum[k]) + imag(spectrum[k])*imag(spectrum[k])
		if power > peak {
			peak, peakBin = power, k
		}
	}
	alias := 20 * math.Log10(2*math.Sqrt(peak)/count)
	fundamental := 20 * math.Log10(2*math.Hypot(real(spectrum[bin]), imag(spectrum[bin]))/count)
	return alias, alias - fundamental, peakBin
}

// Higher harmonics can fold inside the 2x nonlinear stage, before the >=60 dB
// decimator. Report that separately, including the old algorithm on identical
// inputs. The -12 dBFS probes must not introduce an above-floor alias regression.
func TestOversampledHighOrderAliasingIsMeasuredSeparately(t *testing.T) {
	const count = 16384
	plan := fft.New(count, fft.DirectTwiddles)
	worst, worstCase, ordinary := -300.0, "", -300.0
	for _, rate := range []float64{44100, 48000} {
		for _, character := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatTube, SatTape, SatTransformer} {
			for _, amplitude := range []float64{.25, .5, 1} {
				for _, bin := range []int{3501, 6061, 7507} {
					alias, relative, peakBin := toneAlias(t, plan, rate, character, amplitude, bin, OversampledAlgorithmVersion)
					classic, _, _ := toneAlias(t, plan, rate, character, amplitude, bin, TruePeakAlgorithmVersion)
					t.Logf("%.0f Hz %s drive100 input%.2f tone%.1fHz: largest non-harmonic %.2f dBFS / %.2f dBc at %.1fHz; classic %.2f dBFS", rate, character, amplitude, rate*float64(bin)/count, alias, relative, rate*float64(peakBin)/count, classic)
					if alias > worst {
						worst = alias
						worstCase = string(character)
					}
					if amplitude == .25 {
						ordinary = math.Max(ordinary, alias)
						if alias > math.Max(-90, classic+1) {
							t.Errorf("ordinary-level alias regression: %g vs classic %g", alias, classic)
						}
					}
					if !finite(alias) || alias > -25 {
						t.Fatalf("unbounded high-order foldback %.2f dBFS", alias)
					}
				}
			}
		}
	}
	t.Logf("stress worst %.2f dBFS (%s), -12 dBFS input worst %.2f dBFS; neither is the FIR stopband", worst, worstCase, ordinary)
}

func TestHighRateReferenceDistinguishesFoldbackFromIntendedHarmonics(t *testing.T) {
	const count, factor, bin = 16384, 64, 7507
	const rate = 44100.0
	plan := fft.New(count, fft.DirectTwiddles)
	for _, character := range []SatCharacter{SatTube, SatCrisp} {
		for _, amplitude := range []float64{.25, 1} {
			actual, _, aliasBin := toneAlias(t, plan, rate, character, amplitude, bin, OversampledAlgorithmVersion)
			reference := make([]float32, count*factor)
			drive, bias, shape := 4.0, math.Tanh(.12), complex(1.0, 0)
			if character == SatCrisp {
				drive, bias = 4.2*1.1, 0
				omega := 2 * math.Pi * float64(bin) / (2 * count)
				low := complex(.04, 0) / (1 - complex(.96*math.Cos(omega), -.96*math.Sin(omega)))
				shape = 1.35 - .15*low
			}
			norm := drive * (1 - bias*bias)
			curve := func(x float64) float64 { return (math.Tanh(drive*x+math.Atanh(bias)) - bias) / norm }
			makeup := .25 / (.5 * (curve(.25) - curve(-.25)))
			for i := range reference {
				phase := 2 * math.Pi * float64(bin*i) / float64(len(reference))
				x := amplitude * (real(shape)*math.Sin(phase) + imag(shape)*math.Cos(phase))
				reference[i] = float32(makeup * curve(x))
			}
			atAlias := GoertzelMagnitudeDB(reference, rate*factor, rate*float64(aliasBin)/count)
			t.Logf("independent 64x continuous-curve reference %s: input %.2f, alias bin %d: engine %.2f dBFS, reference %.2f dBFS", character, amplitude, aliasBin, actual, atAlias)
			if atAlias > -110 {
				t.Fatal("reference did not distinguish foldback from an intended harmonic")
			}
		}
	}
}

func TestOversampledCharactersRetainProgramGainAndLowLevelResponse(t *testing.T) {
	for _, character := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatClean, SatTube, SatTape, SatTransformer} {
		for _, amount := range []float64{10, 50, 100} {
			p := DefaultParams()
			p.AlgorithmVersion = OversampledAlgorithmVersion
			p.Saturation = SaturationParams{Enabled: true, Character: character, Amount: amount}
			tilt := .025 * amount * boolToFloat(character == SatCrisp || character == SatTape)
			if program := levelChangeDB(saturate(p, 1000, .25)); math.Abs(program) > .8+tilt {
				t.Errorf("%s %.0f: program gain %.2f dB", character, amount, program)
			}
			low := levelChangeDB(saturate(p, 1000, .01))
			if low < -.1 || low > 3+tilt {
				t.Errorf("%s %.0f: low-level gain %.2f dB", character, amount, low)
			}
			flat := .1 + .002*amount*boolToFloat(character == SatCrisp)
			for _, frequency := range []float64{10000, 16000, 20000} {
				if difference := levelChangeDB(saturate(p, frequency, .01)) - low; math.Abs(difference) > flat {
					t.Errorf("%s %.0f: %g Hz response %.2f dB", character, amount, frequency, difference)
				}
			}
		}
	}
}
