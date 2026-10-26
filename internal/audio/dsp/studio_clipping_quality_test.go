package dsp

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"testing"
)

type studioARTruthMetrics struct {
	before, after, hermite                         float64
	acceptedBefore, acceptedAfter, acceptedHermite float64
	damaged, acceptedSamples, acceptedRuns         int
	degradedRuns                                   int
}

// Independent cubic endpoint interpolation, projected onto the known clipped
// sign/threshold constraint. It does not use any AR estimate or known-clean data.
func studioARHermiteBaseline(source []float32, threshold float64) []float32 {
	output := append([]float32(nil), source...)
	for i := 0; i < len(source); {
		if math.Abs(float64(source[i])) < threshold {
			i++
			continue
		}
		start := i
		for i < len(source) && math.Abs(float64(source[i])) >= threshold {
			i++
		}
		if start < 2 || i+1 >= len(source) {
			continue
		}
		a, b := float64(source[start-1]), float64(source[i])
		da, db := a-float64(source[start-2]), float64(source[i+1])-b
		span := float64(i - start + 1)
		for frame := start; frame < i; frame++ {
			x := float64(frame-start+1) / span
			x2, x3 := x*x, x*x*x
			value := (2*x3-3*x2+1)*a + (x3-2*x2+x)*span*da + (-2*x3+3*x2)*b + (x3-x2)*span*db
			sign := math.Copysign(1, float64(source[frame]))
			output[frame] = float32(sign * math.Max(threshold, sign*value))
		}
	}
	return output
}

func studioARCompareTruth(t *testing.T, clean, source, output []float32, report studioARRepairReport) studioARTruthMetrics {
	t.Helper()
	var result studioARTruthMetrics
	baseline := studioARHermiteBaseline(source, report.Threshold)
	for i := 0; i < len(source); {
		if math.Abs(float64(source[i])) < report.Threshold {
			if math.Float32bits(source[i]) != math.Float32bits(output[i]) {
				t.Errorf("reliable frame%d changed exact bytes", i)
			}
			i++
			continue
		}
		start := i
		accepted := false
		for i < len(source) && math.Abs(float64(source[i])) >= report.Threshold {
			accepted = accepted || math.Float32bits(source[i]) != math.Float32bits(output[i])
			i++
		}
		before, after, hermite := 0.0, 0.0, 0.0
		for frame := start; frame < i; frame++ {
			a, b, c := float64(source[frame])-float64(clean[frame]), float64(output[frame])-float64(clean[frame]), float64(baseline[frame])-float64(clean[frame])
			before, after, hermite = before+a*a, after+b*b, hermite+c*c
			if accepted && (float64(source[frame])*float64(output[frame]) <= 0 || math.Abs(float64(output[frame])) < report.Threshold || math.Abs(float64(output[frame])) > 3*report.Threshold) {
				t.Errorf("accepted frame%d violated sign/threshold/amplitude constraint", frame)
			}
		}
		result.before += before
		result.after += after
		result.hermite += hermite
		result.damaged += i - start
		if accepted {
			result.acceptedBefore += before
			result.acceptedAfter += after
			result.acceptedHermite += hermite
			result.acceptedSamples += i - start
			result.acceptedRuns++
			if after > before*1.01+1e-12 {
				result.degradedRuns++
			}
		}
	}
	if result.acceptedRuns != report.Channels[0].AcceptedRuns {
		t.Errorf("truth selected%d runs but report claims%d", result.acceptedRuns, report.Channels[0].AcceptedRuns)
	}
	return result
}

func studioARQualityFixture(rate float64, count int, kind string) []float32 {
	clean := make([]float32, count)
	state := uint32(0x915ac731)
	for i := range clean {
		x := float64(i) / rate
		value := 0.0
		switch kind {
		case "multitone":
			value = .62*math.Sin(2*math.Pi*1499*x+.2) + .35*math.Sin(2*math.Pi*2203*x+.8) + .08
		case "voice-like":
			value = .68*math.Sin(2*math.Pi*397*x+.13) + .23*math.Sin(2*math.Pi*794*x+.7) + .13*math.Sin(2*math.Pi*1191*x+.4) + .09*math.Sin(2*math.Pi*1588*x+1.1)
		case "dc-tone":
			value = .23 + .91*math.Sin(2*math.Pi*997*x+.61)
		case "transient":
			position := (float64(i) - float64(count)/2) / (.0003 * rate)
			value = 1.4 * math.Exp(-position*position/2) * math.Cos(2*math.Pi*2100*x+.4)
		case "noise":
			state ^= state << 13
			state ^= state >> 17
			state ^= state << 5
			value = 1.3 * (2*float64(state)/float64(math.MaxUint32) - 1)
		}
		clean[i] = float32(value)
	}
	return clean
}

func studioARHardClip(clean []float32, threshold float64) []float32 {
	source := make([]float32, len(clean))
	for i, value := range clean {
		source[i] = float32(math.Max(-threshold, math.Min(threshold, float64(value))))
	}
	return source
}

func TestStudioARRepairHeldOutQualityAgainstInputAndHermite(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []string{"multitone", "voice-like", "dc-tone"} {
			t.Run(fmt.Sprintf("rate%.0f/%s", rate, kind), func(t *testing.T) {
				clean := studioARQualityFixture(rate, 8192, kind)
				source := studioARHardClip(clean, .7)
				output, _, report, err := repairStudioClippedPCM(context.Background(), rate, .7, source, source)
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("fixture seed0x915ac731 cleanSHA256%s sourceSHA256%s outputSHA256%s", studioARFixtureHash(clean), studioARFixtureHash(source), studioARFixtureHash(output))
				m := studioARCompareTruth(t, clean, source, output, report)
				coverage := float64(m.acceptedSamples) / float64(m.damaged)
				t.Logf("damaged%d accepted samples%d runs%d coverage%.6f whole input delta%.6fdB accepted input delta%.6fdB accepted Hermite delta%.6fdB degraded runs%d refits%d cached%d work%d exhausted%v", m.damaged, m.acceptedSamples, m.acceptedRuns, coverage, 10*math.Log10(m.after/m.before), 10*math.Log10(m.acceptedAfter/m.acceptedBefore), 10*math.Log10(m.acceptedAfter/m.acceptedHermite), m.degradedRuns, report.Channels[0].AttemptedRuns, report.Channels[0].CachedRuns, report.Channels[0].WorkUnits, report.Channels[0].WorkExhausted)
				if m.acceptedSamples == 0 || coverage < .5 {
					t.Error("OPEN: predictable fixture did not reach50percent damaged-sample coverage")
				}
				if m.acceptedAfter > .25*m.acceptedBefore || m.acceptedAfter > .8*m.acceptedHermite || m.after > .95*m.before || m.degradedRuns != 0 {
					t.Error("OPEN: selected estimates failed accepted-quality/Hermite/nondegradation gate")
				}
			})
		}
	}
}

func TestStudioARRepairUnpredictableTruthAbstention(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []string{"transient", "noise"} {
			t.Run(fmt.Sprintf("rate%.0f/%s", rate, kind), func(t *testing.T) {
				clean := studioARQualityFixture(rate, 4096, kind)
				source := studioARHardClip(clean, .7)
				output, _, report, err := repairStudioClippedPCM(context.Background(), rate, .7, source, source)
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("fixture seed0x915ac731 cleanSHA256%s sourceSHA256%s outputSHA256%s", studioARFixtureHash(clean), studioARFixtureHash(source), studioARFixtureHash(output))
				m := studioARCompareTruth(t, clean, source, output, report)
				t.Logf("accepted%d damaged%d unresolved%d total error ratio%.9f", m.acceptedSamples, m.damaged, report.Channels[0].UnresolvedRuns, m.after/m.before)
				if m.degradedRuns != 0 || m.after > m.before*1.01+1e-12 {
					t.Error("OPEN: unpredictable source was degraded beyond1percent error threshold")
				}
				if kind == "noise" && m.acceptedRuns != 0 {
					t.Error("OPEN: random-noise peaks were claimed as confidently reconstructed")
				}
			})
		}
	}
}

func studioARFixtureHash(samples []float32) string {
	data := make([]byte, 4*len(samples))
	for i, value := range samples {
		binary.LittleEndian.PutUint32(data[i*4:(i+1)*4], math.Float32bits(value))
	}
	return fmt.Sprintf("%x", sha256.Sum256(data))
}
