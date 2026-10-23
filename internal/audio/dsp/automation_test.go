package dsp

import (
	"math"
	"testing"
)

func TestAutomationOriginalStagesAndAtomicLanes(t *testing.T) {
	params := DefaultParams()
	params.Limiter.Enabled = true
	params.Limiter.CeilingDBTP = -6
	params.Stereo.Enabled = true
	engine := NewEngine(48000)
	engine.SetParams(params)
	left, right := []float32{.9, .9}, []float32{-.9, -.9}
	outL, outR := []float32{9, 9}, []float32{9, 9}
	if engine.ProcessAutomationBlock(left, right, outL, outR, []float64{0, math.NaN()}, nil) || outL[0] != 9 || engine.Params() != params {
		t.Fatal("invalid lane changed engine or destination")
	}
	if !engine.ProcessAutomationBlock(left, right, outL, outR, []float64{6, 6}, []float64{200, 200}) {
		t.Fatal("valid lanes rejected")
	}
	for i := range outL {
		if math.Abs(float64(outL[i])) > .502 || math.Abs(float64(outR[i])) > .502 {
			t.Fatal("gain/width applied after limiter", outL, outR)
		}
	}
	params = DefaultParams()
	params.Limiter.Enabled = false
	params.Stereo.Enabled = false
	engine.SetParams(params)
	engine.Reset()
	if !engine.ProcessAutomationBlock(left, right, outL, outR, nil, []float64{0, 0}) || outL[0] != left[0] || outR[0] != right[0] {
		t.Fatal("disabled stereo was implicitly enabled")
	}
	params.Stereo.Enabled = true
	engine.SetParams(params)
	engine.Reset()
	engine.ProcessAutomationBlock(left, right, outL, outR, nil, []float64{0, 0})
	if outL[0] != 0 || outR[0] != 0 {
		t.Fatal("neutral baseline swallowed width activation", outL, outR)
	}
	params.Bypass = true
	engine.SetParams(params)
	engine.ProcessAutomationBlock(left, right, outL, outR, []float64{6, 6}, []float64{0, 0})
	if outL[0] != left[0] || outR[0] != right[0] {
		t.Fatal("automation bypass ignored")
	}
}
func TestEQResponseMatchesRenderedSine(t *testing.T) {
	for _, filter := range []FilterType{FilterHighPass, FilterLowShelf, FilterPeaking, FilterHighShelf} {
		for _, frequency := range []float64{80, 997, 8000} {
			params := DefaultParams()
			params.Limiter.Enabled = false
			for i := range params.Bands {
				params.Bands[i].Enabled = false
			}
			params.Bands[2] = BandParams{FreqHz: 997, GainDB: 3, Q: 1.2, Type: filter, Enabled: true}
			engine := NewEngine(48000)
			engine.SetParams(params)
			left, right, outL, outR := make([]float32, 48000), make([]float32, 48000), make([]float32, 48000), make([]float32, 48000)
			for i := range left {
				left[i] = float32(.05 * math.Sin(2*math.Pi*frequency*float64(i)/48000))
				right[i] = left[i]
			}
			engine.ProcessBlock(left, right, outL, outR)
			input, output := 0.0, 0.0
			for i := 24000; i < 48000; i++ {
				input += float64(left[i]) * float64(left[i])
				output += float64(outL[i]) * float64(outL[i])
			}
			measured := 10 * math.Log10(output/input)
			predicted := EQResponseDB(48000, frequency, true, params.Bands)
			if math.Abs(measured-predicted) > .02 {
				t.Fatalf("filter %s frequency %g measured %.6f predicted %.6f", filter, frequency, measured, predicted)
			}
		}
	}
}
