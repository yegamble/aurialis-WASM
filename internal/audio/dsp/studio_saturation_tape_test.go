package dsp

import (
	"math"
	"testing"
)

func studioSaturationToneGain(t *testing.T, rate, frequency, amplitude float64, character SatCharacter) float64 {
	t.Helper()
	s := mustStudioSaturation(t, rate, 100, character)
	var output []float32
	for frame := range int(rate * .6) {
		x := amplitude * math.Sin(2*math.Pi*frequency*float64(frame)/rate)
		l, _ := s.process(x, x)
		if frame >= int(rate*.2) {
			output = append(output, float32(l))
		}
	}
	return GoertzelMagnitudeDB(output, rate, frequency) - 20*math.Log10(amplitude)
}

func TestStudioTapeBroadHeadResponseUsesPhysicalFrequency(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		low := studioSaturationToneGain(t, rate, 55, .001, SatTape)
		mid := studioSaturationToneGain(t, rate, 1000, .001, SatTape)
		if math.Abs((low-mid)-1.5) > .1 {
			t.Fatalf("rate %g Tape head/mid response %g/%g dB", rate, low, mid)
		}
	}
}

func TestStudioTapeDampingDependsOnSignalPower(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, amplitude := range []float64{.001, .35} {
			withDamping := mustStudioSaturation(t, rate, 100, SatTape)
			withoutDamping := withDamping
			withoutDamping.tapeCoeffs.damping = 0
			frequency := math.Min(10000, .2*rate)
			withPower, withoutPower := 0.0, 0.0
			for frame := range int(rate * .3) {
				x := amplitude * math.Sin(2*math.Pi*frequency*float64(frame)/rate)
				l, _ := withDamping.process(x, x)
				r, _ := withoutDamping.process(x, x)
				if frame > int(rate*.2) {
					withPower += l * l
					withoutPower += r * r
				}
			}
			delta := 10 * math.Log10(withPower/withoutPower)
			if (amplitude == .001 && math.Abs(delta) > .001) || (amplitude == .35 && delta > -.03) {
				t.Fatalf("rate %g amplitude %g level-dependent HF damping %g dB", rate, amplitude, delta)
			}
		}
	}
}

func TestStudioTapeNoDriveDCResetAndDriveTransitions(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		s := mustStudioSaturation(t, rate, 0, SatTape)
		for frame := range 512 {
			input := 0.0
			if frame == 0 {
				input = 1
			}
			l, r := s.process(input, input)
			want := 0.0
			if frame == studioSaturationLatency {
				want = 1
			}
			if l != want || r != want {
				t.Fatal("Tape no-drive path failed exact delay")
			}
		}
		p := s.params
		p.Amount = 100
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		last := 0.0
		for range int(rate) {
			last, _ = s.process(1, 1)
		}
		if math.Abs(last) > math.Pow(10, -90.0/20) {
			t.Fatal("Tape DC did not settle below -90 dBFS")
		}
		for _, amount := range []float64{25, 100, 0} {
			p.Amount = amount
			if err := s.setParams(p); err != nil {
				t.Fatal(err)
			}
			for frame := range 1000 {
				x := .2 + .01*math.Sin(float64(frame)*.63)
				l, r := s.process(x, x*.5)
				if !finite(l) || !finite(r) || math.Abs(l) > 2 || math.Abs(r) > 2 {
					t.Fatal("Tape drive transition emitted a spike")
				}
			}
		}
		for _, value := range []float64{math.MaxFloat32, math.NaN(), math.Inf(-1), 0} {
			l, r := s.process(value, -value)
			if !finite(l) || !finite(r) {
				t.Fatal("Tape emitted a nonfinite overload")
			}
		}
		s.resetHistory()
		if s.tape != ([2]studioTapeState{}) {
			t.Fatal("Tape reset retained head/damping/ADAA memory")
		}
		for range 512 {
			if l, r := s.process(0, 0); l != 0 || r != 0 {
				t.Fatal("Tape reset replayed old audio")
			}
		}
	}
}

func TestStudioTapeNominalAliasAndPublishedHotDriveWorstCase(t *testing.T) {
	nominalWorst, hotWorst := -1000.0, -1000.0
	for _, rate := range []float64{44100, 48000} {
		for _, bin := range []int{997, 2011, 3451} {
			alias, fundamental := studioSaturationAlias(t, rate, 25, .25, SatTape, bin)
			nominalWorst = math.Max(nominalWorst, alias)
			if alias > -75 || fundamental < -15 {
				t.Fatalf("Tape nominal rate %g bin %d alias %g fundamental %g", rate, bin, alias, fundamental)
			}
			alias, fundamental = studioSaturationAlias(t, rate, 100, 1, SatTape, bin)
			hotWorst = math.Max(hotWorst, alias)
			if !finite(alias) || !finite(fundamental) || fundamental < -20 {
				t.Fatal("Tape hot fixture silent/nonfinite")
			}
		}
	}
	t.Logf("Tape coherent nominal amount25/peak.25 unwanted foldback worst %g dBFS; hot amount100/peak1 worst %g dBFS", nominalWorst, hotWorst)
}

func TestStudioTapeProcessingDoesNotAllocate(t *testing.T) {
	s := mustStudioSaturation(t, 48000, 25, SatTape)
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			s.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("Tape processing allocated")
	}
}
