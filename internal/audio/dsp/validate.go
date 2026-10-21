package dsp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
)

// ValidateParams rejects non-finite and unsupported settings before they reach
// persistent DSP state. Disabled stages must still carry valid settings.
func ValidateParams(p Params) error {
	values := []struct {
		name            string
		value, min, max float64
	}{
		{"inputGainDb", p.InputGainDB, -36, 36},
		{"compressor.thresholdDb", p.Compressor.ThresholdDB, -80, 12},
		{"compressor.ratio", p.Compressor.Ratio, 1, 100},
		{"compressor.attackMs", p.Compressor.AttackMS, 0.02, 500},
		{"compressor.releaseMs", p.Compressor.ReleaseMS, 5, 10000},
		{"compressor.kneeDb", p.Compressor.KneeDB, 0, 24},
		{"compressor.makeupDb", p.Compressor.MakeupDB, -24, 36},
		{"compressor.sidechainHpfHz", p.Compressor.SidechainHPFHz, 0, 1000},
		{"saturation.amount", p.Saturation.Amount, 0, 100},
		{"stereo.widthPct", p.Stereo.WidthPct, 0, 200},
		{"stereo.crossoverHz", p.Stereo.CrossoverHz, 20, 1000},
		{"limiter.ceilingDbtp", p.Limiter.CeilingDBTP, -24, 0},
		{"limiter.targetLufs", p.Limiter.TargetLUFS, -36, -5},
		{"limiter.releaseMs", p.Limiter.ReleaseMS, 10, 10000},
		{"repair.deEssDb", p.Repair.DeEssDB, 0, 24},
		{"repair.transientDb", p.Repair.TransientDB, -24, 24},
	}
	for _, v := range values {
		if !finite(v.value) || v.value < v.min || v.value > v.max {
			return fmt.Errorf("%s must be finite and in [%g,%g]", v.name, v.min, v.max)
		}
	}
	for i, b := range p.Bands {
		if !finite(b.FreqHz) || b.FreqHz < 10 || b.FreqHz > 40000 || !finite(b.GainDB) || b.GainDB < -24 || b.GainDB > 24 || !finite(b.Q) || b.Q < 0.1 || b.Q > 20 {
			return fmt.Errorf("band %d requires frequency 10–40000 Hz, gain -24–24 dB, and Q 0.1–20", i)
		}
		switch b.Type {
		case FilterHighPass, FilterLowShelf, FilterPeaking, FilterHighShelf:
		default:
			return fmt.Errorf("band %d has an unsupported filter type", i)
		}
	}
	switch p.Compressor.Topology {
	case CompOptical, CompVariableMu, CompFET, CompVCA:
	default:
		return errors.New("unsupported compressor topology")
	}
	switch p.Saturation.Character {
	case SatWarm, SatThick, SatCrisp:
	default:
		return errors.New("unsupported saturation character")
	}
	if p.DitherBits != 0 && p.DitherBits != 16 && p.DitherBits != 24 {
		return errors.New("ditherBits must be 0, 16, or 24")
	}
	return nil
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// DecodeParamsJSON applies a strict JSON update to base and validates the result.
// Partial objects preserve unrelated controls. Supplied bands must contain exactly
// five complete band objects. Unknown fields, nulls, and trailing data are rejected.
func DecodeParamsJSON(data []byte, base Params) (Params, error) {
	if len(data) > 16384 {
		return base, errors.New("DSP settings exceed 16 KiB")
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return base, errors.New("DSP settings must be a JSON object")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return base, err
	}
	if err := validateJSONValues(object); err != nil {
		return base, err
	}
	if raw, ok := object["bands"]; ok {
		var bands []json.RawMessage
		if err := json.Unmarshal(raw, &bands); err != nil {
			return base, err
		}
		if len(bands) != NumEQBands {
			return base, errors.New("bands must contain exactly five entries")
		}
		for _, rawBand := range bands {
			var band map[string]json.RawMessage
			if err := json.Unmarshal(rawBand, &band); err != nil {
				return base, err
			}
			if err := validateJSONValues(band); err != nil {
				return base, err
			}
			for _, field := range []string{"freqHz", "gainDb", "q", "type", "enabled"} {
				if _, ok := band[field]; !ok {
					return base, fmt.Errorf("band requires %s", field)
				}
			}
		}
	}
	next := base
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&next); err != nil {
		return base, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return base, errors.New("trailing DSP settings JSON")
	}
	if err := ValidateParams(next); err != nil {
		return base, err
	}
	return next, nil
}

func validateJSONValues(object map[string]json.RawMessage) error {
	for _, value := range object {
		value = bytes.TrimSpace(value)
		if bytes.Equal(value, []byte("null")) {
			return errors.New("DSP settings cannot contain null")
		}
		if len(value) > 0 && value[0] == '{' {
			var nested map[string]json.RawMessage
			if err := json.Unmarshal(value, &nested); err != nil {
				return err
			}
			if err := validateJSONValues(nested); err != nil {
				return err
			}
		}
	}
	return nil
}
