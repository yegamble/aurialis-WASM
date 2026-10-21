package dsp

import (
	"math"
	"strconv"
	"testing"
)

func TestDerivedSettingsRefreshAfterUpdateAndReset(t *testing.T) {
	changes := []struct {
		name  string
		apply func(*Params)
	}{
		{"attack", func(p *Params) { p.Compressor.AttackMS = 0.4 }},
		{"release", func(p *Params) { p.Compressor.ReleaseMS = 45 }},
		{"saturation", func(p *Params) { p.Saturation.Amount = 62 }},
		{"character", func(p *Params) { p.Saturation.Character = SatCrisp }},
		{"width", func(p *Params) { p.Stereo.WidthPct = 155 }},
		{"ceiling", func(p *Params) { p.Limiter.CeilingDBTP = -11 }},
		{"limiter-release", func(p *Params) { p.Limiter.ReleaseMS = 320 }},
		{"peak-mode", func(p *Params) { p.Limiter.TruePeak = !p.Limiter.TruePeak }},
		{"de-ess", func(p *Params) { p.Repair.DeEssDB = 12 }},
		{"transient", func(p *Params) { p.Repair.TransientDB = -4 }},
	}
	for _, rate := range []float64{8000, 16000, 44100, 48000, 96000, 192000} {
		t.Run(strconv.FormatFloat(rate, 'f', 0, 64), func(t *testing.T) {
			base := DefaultParams()
			base.InputGainDB = 3
			base.Compressor.ThresholdDB = -24
			base.Compressor.Ratio = 3
			base.Saturation.Amount = 23
			base.Stereo.WidthPct = 115
			base.Limiter.Enabled = true
			base.Limiter.CeilingDBTP = -3
			base.Repair = RepairParams{Enabled: true, DeEssDB: 3, TransientDB: 2, DeClip: true}
			left, right := make([]float32, 512), make([]float32, 512)
			for i := range left {
				left[i] = float32(0.91 * math.Cos(2*math.Pi*997*float64(i)/rate))
				right[i] = float32(0.83 * math.Cos(2*math.Pi*617*float64(i)/rate))
			}
			engine := NewEngine(rate)
			engine.SetParams(base)
			actualL, actualR := make([]float32, len(left)), make([]float32, len(left))
			expectedL, expectedR := make([]float32, len(left)), make([]float32, len(left))
			for _, change := range changes {
				t.Run(change.name, func(t *testing.T) {
					// Build old filter/envelope history, update one setting, then reset only
					// history. Its coefficients must match a newly constructed configured engine.
					engine.SetParams(base)
					engine.ProcessBlock(left, right, actualL, actualR)
					updated := base
					change.apply(&updated)
					engine.SetParams(updated)
					engine.Reset()
					fresh := NewEngine(rate)
					fresh.SetParams(updated)
					engine.ProcessBlock(left, right, actualL, actualR)
					fresh.ProcessBlock(left, right, expectedL, expectedR)
					for i := range actualL {
						if math.Float32bits(actualL[i]) != math.Float32bits(expectedL[i]) || math.Float32bits(actualR[i]) != math.Float32bits(expectedR[i]) {
							t.Fatalf("stale coefficients after update/reset at frame %d", i)
						}
					}
					// Rejecting an invalid update must preserve coefficients AND live state.
					reference := *engine
					invalid := updated
					invalid.Compressor.AttackMS = math.NaN()
					engine.SetParams(invalid)
					engine.ProcessBlock(left, right, actualL, actualR)
					reference.ProcessBlock(left, right, expectedL, expectedR)
					for i := range actualL {
						if math.Float32bits(actualL[i]) != math.Float32bits(expectedL[i]) || math.Float32bits(actualR[i]) != math.Float32bits(expectedR[i]) {
							t.Fatalf("invalid update changed audio at frame %d", i)
						}
					}
				})
			}
		})
	}
}
