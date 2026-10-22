package dsp

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

type eqResponseFixture struct {
	Rate       float64      `json:"rate"`
	Bands      []BandParams `json:"bands"`
	Probes     []float64    `json:"probes"`
	MeasuredDB []float64    `json:"measuredDb"`
}

func eqResponseCases() []eqResponseFixture {
	var cases []eqResponseFixture
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []FilterType{FilterHighPass, FilterLowShelf, FilterPeaking, FilterHighShelf} {
			center := 1000.0
			switch kind {
			case FilterHighPass:
				center = 120
			case FilterLowShelf:
				center = 250
			case FilterHighShelf:
				center = math.Min(12000, rate*.18)
			case FilterPeaking:
			}
			qs := []float64{.707}
			if rate == 48000 {
				qs = append(qs, 3)
			}
			for _, q := range qs {
				for _, gain := range []float64{-9, 6} {
					cases = append(cases, eqResponseFixture{Rate: rate, Bands: []BandParams{{FreqHz: center, GainDB: gain, Q: q, Type: kind, Enabled: true}}, Probes: []float64{center * .5, center, math.Min(rate*.45, center*2)}})
				}
			}
		}
		cases = append(cases, eqResponseFixture{Rate: rate, Bands: []BandParams{{FreqHz: 80, GainDB: 3, Q: .707, Type: FilterLowShelf, Enabled: true}, {FreqHz: 1000, GainDB: -4, Q: 2, Type: FilterPeaking, Enabled: true}, {FreqHz: 4000, GainDB: 2, Q: .707, Type: FilterHighShelf, Enabled: true}}, Probes: []float64{80, 1000, rate * .4}})
	}
	for _, kind := range []FilterType{FilterHighPass, FilterLowShelf, FilterPeaking, FilterHighShelf} {
		cases = append(cases, eqResponseFixture{Rate: 8000, Bands: []BandParams{{FreqHz: 40000, GainDB: 6, Q: .707, Type: kind, Enabled: true}}, Probes: []float64{1000, 3500, 3760}})
		cases = append(cases, eqResponseFixture{Rate: 8000, Bands: []BandParams{{FreqHz: 10, GainDB: -9, Q: .707, Type: kind, Enabled: true}}, Probes: []float64{5, 10, 20}})
	}
	return cases
}

// Measure actual settled sine output, independent of the display's transfer
// function. Float32 samples exercise the same engine used by WASM and export.
func measureEQResponse(t *testing.T, fixture eqResponseFixture, frequency float64) float64 {
	t.Helper()
	params := DefaultParams()
	for i := range params.Bands {
		params.Bands[i].Enabled = false
	}
	copy(params.Bands[:], fixture.Bands)
	if err := ValidateParams(params); err != nil {
		t.Fatal(err)
	}
	input := make([]float32, int(fixture.Rate*math.Max(1, 30/frequency)))
	left, right := make([]float32, len(input)), make([]float32, len(input))
	for i := range input {
		input[i] = float32(.1 * math.Sin(2*math.Pi*frequency*float64(i)/fixture.Rate))
	}
	engine := NewEngine(fixture.Rate)
	engine.SetParams(params)
	engine.ProcessBlock(input, input, left, right)
	return GoertzelMagnitudeDB(left, fixture.Rate, frequency) - GoertzelMagnitudeDB(input, fixture.Rate, frequency)
}

// Regenerate intentionally with AURIALIS_WRITE_EQ_RESPONSE_FIXTURE=1 and
// go test -run TestNativeEQResponseFixtures ./internal/audio/dsp from the repo.
// Normal runs remeasure the saved oracle without rewriting it.
func TestNativeEQResponseFixtures(t *testing.T) {
	const fixturePath = "../../../src/lib/__tests__/fixtures/eq-response-native.json"
	if os.Getenv("AURIALIS_WRITE_EQ_RESPONSE_FIXTURE") == "1" {
		cases := eqResponseCases()
		for i := range cases {
			for _, frequency := range cases[i].Probes {
				cases[i].MeasuredDB = append(cases[i].MeasuredDB, measureEQResponse(t, cases[i], frequency))
			}
		}
		// One compact JSON row per configuration keeps the acoustic oracle reviewable.
		raw := []byte("[\n")
		for i, fixture := range cases {
			row, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			raw = append(raw, row...)
			if i+1 < len(cases) {
				raw = append(raw, ',')
			}
			raw = append(raw, '\n')
		}
		raw = append(raw, ']', '\n')
		if err := os.WriteFile(fixturePath, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []eqResponseFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != len(eqResponseCases()) {
		t.Fatal("native EQ response matrix is incomplete")
	}
	for _, fixture := range fixtures {
		if len(fixture.Probes) != len(fixture.MeasuredDB) {
			t.Fatal("missing measured EQ response")
		}
		for i, frequency := range fixture.Probes {
			actual := measureEQResponse(t, fixture, frequency)
			if math.Abs(actual-fixture.MeasuredDB[i]) > .0001 {
				t.Fatalf("native EQ response changed at %.0f Hz/%g Hz: got %.8f expected %.8f", fixture.Rate, frequency, actual, fixture.MeasuredDB[i])
			}
		}
	}
}
