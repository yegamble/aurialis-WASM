package steminfer

// cspell:words steminfer resampler

import (
	"context"
	"errors"
	"math"
	"testing"
)

func projectionAmplitude(samples []float32, rate, frequency float64, trim int) float64 {
	var sine, cosine float64
	for i := trim; i < len(samples)-trim; i++ {
		angle := 2 * math.Pi * frequency * float64(i) / rate
		s, c := math.Sincos(angle)
		sine += float64(samples[i]) * s
		cosine += float64(samples[i]) * c
	}
	return 2 * math.Hypot(sine, cosine) / float64(len(samples)-2*trim)
}
func TestResamplingExactRationalClockPartitionAndDC(t *testing.T) {
	for _, rates := range [][2]int{{44100, 44100}, {8001, 44100}, {44100, 8001}, {48000, 44100}, {44100, 192000}, {192000, 44100}} {
		plan, err := newResamplePlan(context.Background(), rates[0], rates[1])
		if err != nil {
			t.Fatal(err)
		}
		source := make([]float32, 1027)
		for i := range source {
			source[i] = .125
		}
		length := (len(source)*rates[1] + rates[0] - 1) / rates[0]
		whole := make([]float32, length)
		if err := plan.into(context.Background(), whole, source, 0); err != nil {
			t.Fatal(err)
		}
		fragmented := make([]float32, length)
		for first := 0; first < length; first += 127 {
			if err := plan.into(context.Background(), fragmented[first:min(first+127, length)], source, first); err != nil {
				t.Fatal(err)
			}
		}
		for i, value := range whole {
			if value != fragmented[i] || math.Abs(float64(value)-.125) > 4e-8 {
				t.Fatalf("rates%v sample%d whole%g fragmented%g", rates, i, value, fragmented[i])
			}
		}
		recovered := make([]float32, len(source))
		inverse, err := newResamplePlan(context.Background(), rates[1], rates[0])
		if err != nil {
			t.Fatal(err)
		}
		if err := inverse.into(context.Background(), recovered, whole, 0); err != nil {
			t.Fatal(err)
		}
		if len(recovered) != 1027 {
			t.Fatal("original length changed")
		}
		for _, value := range recovered {
			if math.Abs(float64(value)-.125) > 8e-8 {
				t.Fatal("roundtrip DC changed", value)
			}
		}
	}
}
func TestResamplingPassbandAndDownsampleAliasRejection(t *testing.T) {
	for _, rates := range [][2]int{{8001, 44100}, {44100, 8001}, {48000, 44100}, {44100, 192000}, {192000, 44100}} {
		plan, err := newResamplePlan(context.Background(), rates[0], rates[1])
		if err != nil {
			t.Fatal(err)
		}
		source := make([]float32, rates[0])
		frequency := 997.0
		for i := range source {
			source[i] = float32(math.Sin(2 * math.Pi * frequency * float64(i) / float64(rates[0])))
		}
		output := make([]float32, rates[1])
		if err := plan.into(context.Background(), output, source, 0); err != nil {
			t.Fatal(err)
		}
		// Independent analytic oscillator projection, away from reflected edges.
		amplitude := projectionAmplitude(output, float64(rates[1]), frequency, rates[1]/4)
		db := 20 * math.Log10(amplitude)
		if math.Abs(db) > .025 {
			t.Fatalf("rates%v passband%gdB", rates, db)
		}
		if rates[0] <= rates[1] {
			continue
		}
		aliasFrequency := float64(rates[1]) * .7
		if aliasFrequency >= float64(rates[0])*.5 {
			continue
		}
		for i := range source {
			source[i] = float32(math.Sin(2 * math.Pi * aliasFrequency * float64(i) / float64(rates[0])))
		}
		if err := plan.into(context.Background(), output, source, 0); err != nil {
			t.Fatal(err)
		}
		var power float64
		for _, value := range output[len(output)/4 : 3*len(output)/4] {
			power += float64(value) * float64(value)
		}
		rms := math.Sqrt(power / float64(len(output)/2))
		if 20*math.Log10(math.Max(rms, 1e-30)) > -75 {
			t.Fatalf("rates%v alias RMS%gdBFS", rates, 20*math.Log10(rms))
		}
	}
}
func TestResamplingShortEdgesImpulsePositionAndCancellation(t *testing.T) {
	plan, err := newResamplePlan(context.Background(), 8001, 44100)
	if err != nil {
		t.Fatal(err)
	}
	for _, length := range []int{1, 2, 127, 129, 1025} {
		source := make([]float32, length)
		source[length/2] = 1
		output := make([]float32, (length*44100+8000)/8001)
		if err := plan.into(context.Background(), output, source, 0); err != nil {
			t.Fatal(length, err)
		}
		for _, value := range output {
			if !finite32(value) {
				t.Fatal("non-finite short conversion")
			}
		}
		if length > 1000 {
			peak := 0
			for i := range output {
				if math.Abs(float64(output[i])) > math.Abs(float64(output[peak])) {
					peak = i
				}
			}
			if math.Abs(float64(peak)-float64(length/2)*44100/8001) > 1 {
				t.Fatal("centered impulse shifted", peak)
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := newResamplePlan(ctx, 44100, 48000); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := plan.into(ctx, make([]float32, 1), []float32{1}, 0); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := plan.into(context.Background(), make([]float32, 100), []float32{1}, 0); err == nil {
		t.Fatal("excess duration accepted")
	}
	if err := plan.into(context.Background(), make([]float32, 1), []float32{float32(math.NaN())}, 0); err == nil {
		t.Fatal("non-finite source accepted")
	}
	for _, rates := range [][2]int{{0, 44100}, {44100, 192001}, {7999, 44100}} {
		if _, err := newResamplePlan(context.Background(), rates[0], rates[1]); err == nil {
			t.Fatal("unbounded rate accepted")
		}
	}
}
