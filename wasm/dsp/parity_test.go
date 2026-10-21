package main

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

type nativeParityFixture struct {
	Rate        float64    `json:"rate"`
	Params      dsp.Params `json:"params"`
	Left        []float32  `json:"left"`
	Right       []float32  `json:"right"`
	OutputLeft  []float32  `json:"outputLeft"`
	OutputRight []float32  `json:"outputRight"`
}

// This opt-in fixture generator lets verify.mjs compare a real compiled WASM
// bridge with native output from the same engine and exact float32 input bytes.
func TestWriteNativeParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_PARITY_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_PARITY_FIXTURE for compiled-WASM parity verification")
	}
	var fixtures []nativeParityFixture
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, mode := range []string{"neutral", "gain", "chain", "bypass", "monitor"} {
			p := dsp.DefaultParams()
			if mode == "gain" {
				p.InputGainDB = -6
			}
			if mode == "chain" || mode == "bypass" || mode == "monitor" {
				p.InputGainDB = 3
				p.Bands[1].GainDB = -3
				p.Bands[3].GainDB = 2
				p.Compressor.Ratio = 4
				p.Compressor.ThresholdDB = -18
				p.Saturation.Amount = 25
				p.Stereo.WidthPct = 125
				p.Stereo.MonoBass = true
				p.Limiter.Enabled = true
				p.Bypass = mode == "bypass"
			}
			if mode == "monitor" {
				p.LoudnessMatchAB = true
				p.InputGainDB = -12
				p.Limiter.CeilingDBTP = -12
				p.DitherBits = 16
			}
			f := nativeParityFixture{Rate: rate, Params: p, Left: make([]float32, 1024), Right: make([]float32, 1024), OutputLeft: make([]float32, 1024), OutputRight: make([]float32, 1024)}
			// Rational integer arithmetic produces exact identical native/JS inputs.
			for i := range f.Left {
				f.Left[i] = float32((i*73)%997-498) / 1024
				f.Right[i] = float32((i*31)%991-495) / 1024
			}
			bridge := NewBridge(rate)
			bridge.SetParams(p)
			for start := 0; start < len(f.Left); start += 128 {
				end := start + 128
				bridge.ProcessBlock(f.Left[start:end], f.Right[start:end], f.OutputLeft[start:end], f.OutputRight[start:end])
			}
			fixtures = append(fixtures, f)
		}
	}
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, control := range supportedControlCases() {
			for _, params := range []dsp.Params{control.before, control.after} {
				l, r := controlInput(rate)
				outL, outR := renderControl(rate, params, l, r)
				fixtures = append(fixtures, nativeParityFixture{Rate: rate, Params: params, Left: l, Right: r, OutputLeft: outL, OutputRight: outR})
			}
		}
	}

	raw, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	} // #nosec G703 -- explicit local test fixture path, not a request path.
}

// This opt-in regression compares against PRE-CHANGE output, rather than
// regenerating expectations from the implementation currently under test.
func TestNativeMatchesStoredParityFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_BASELINE_PARITY_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_BASELINE_PARITY_FIXTURE for stored-output regression")
	}
	raw, err := os.ReadFile(path) // #nosec G304 -- explicit local test fixture, never an audio/request path.
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []nativeParityFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("baseline fixture is empty")
	}
	for index, f := range fixtures {
		if len(f.Left) == 0 || len(f.Left) != len(f.Right) || len(f.Left) != len(f.OutputLeft) || len(f.Left) != len(f.OutputRight) {
			t.Fatalf("invalid baseline lengths in fixture %d", index)
		}
		bridge := NewBridge(f.Rate)
		bridge.SetParams(f.Params)
		outL, outR := make([]float32, 128), make([]float32, 128)
		for start := 0; start < len(f.Left); start += 128 {
			end := min(start+128, len(f.Left))
			bridge.ProcessBlock(f.Left[start:end], f.Right[start:end], outL[:end-start], outR[:end-start])
			for offset := 0; offset < end-start; offset++ {
				if math.Float32bits(outL[offset]) != math.Float32bits(f.OutputLeft[start+offset]) || math.Float32bits(outR[offset]) != math.Float32bits(f.OutputRight[start+offset]) {
					t.Fatalf("pre-change output mismatch in fixture %d frame %d", index, start+offset)
				}
			}
		}
	}
	t.Logf("matched %d pre-change native fixtures bit for bit", len(fixtures))
}

func TestWriteNativeMeterFixture(t *testing.T) {
	path := os.Getenv("AURIALIS_METER_FIXTURE")
	if path == "" {
		t.Skip("set AURIALIS_METER_FIXTURE for independent FFmpeg comparison")
	}
	type fixture struct {
		Rate    float64     `json:"rate"`
		Mode    string      `json:"mode"`
		Metrics dsp.Metrics `json:"metrics"`
	}
	var fixtures []fixture
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, mode := range []string{"tone", "gate", "peak", "low", "high"} {
			duration := 3
			if mode == "gate" {
				duration = 9
			}
			samples := make([]float32, int(rate)*duration)
			for i := range samples {
				frequency, amplitude := 997.0, 0.1
				if mode == "low" {
					frequency = 80
				}
				if mode == "high" {
					frequency = 8000
				}
				if mode == "gate" {
					if i >= int(rate)*3 {
						amplitude = 0
					}
					if i >= int(rate)*6 {
						amplitude = 0.001
					}
				}
				value := amplitude * math.Sin(2*math.Pi*frequency*float64(i)/rate)
				if mode == "low" || mode == "high" {
					value *= math.Min(1, math.Min(float64(i)/100, float64(len(samples)-1-i)/100))
				}
				if mode == "peak" {
					taper := math.Min(1, math.Min(float64(i)/100, float64(len(samples)-1-i)/100))
					value = taper * math.Sin(math.Pi*float64(i)/2+math.Pi/4)
				}
				samples[i] = float32(value)
			}
			fixtures = append(fixtures, fixture{Rate: rate, Mode: mode, Metrics: dsp.MeasureStereo(samples, samples, rate)})
		}
	}
	raw, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	} // #nosec G703 -- explicit local test fixture path, not a request path.
}
