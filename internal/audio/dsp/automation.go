package dsp

import "math"

type automationLanes struct{ gain, width []float64 }

// ProcessAutomationBlock applies validated per-sample gain/width at their original stages.
// Invalid lane lengths or values reject before engine history or destinations change.
// Empty lanes retain the exact legacy ProcessBlock path; bypass and disabled stereo win.
func (e *Engine) ProcessAutomationBlock(inL, inR, outL, outR []float32, gainDB, widthPct []float64) bool {
	count := min(len(inL), len(inR), len(outL), len(outR))
	if (len(gainDB) != 0 && len(gainDB) < count) || (len(widthPct) != 0 && len(widthPct) < count) {
		return false
	}
	for i := 0; i < count; i++ {
		if len(gainDB) > 0 && (!finite(gainDB[i]) || gainDB[i] < -36 || gainDB[i] > 36) {
			return false
		}
		if len(widthPct) > 0 && (!finite(widthPct[i]) || widthPct[i] < 0 || widthPct[i] > 200) {
			return false
		}
	}
	if len(gainDB) == 0 && len(widthPct) == 0 {
		e.ProcessBlock(inL, inR, outL, outR)
		return true
	}
	lanes := automationLanes{gain: gainDB, width: widthPct}
	e.processBlock(inL, inR, outL, outR, &lanes)
	return true
}

// ApplyAutomationControls updates only the eight expensive scalar targets at a bounded cell edge.
// It never enables modules or changes gain/width monitoring. Invalid vectors are atomic.
func (e *Engine) ApplyAutomationControls(eq [NumEQBands]float64, threshold, ratio, amount float64) bool {
	next := e.params
	for i, value := range eq {
		next.Bands[i].GainDB = value
	}
	next.Compressor.ThresholdDB, next.Compressor.Ratio, next.Saturation.Amount = threshold, ratio, amount
	if ValidateParams(next) != nil {
		return false
	}
	if next != e.params {
		e.SetParams(next)
	}
	return true
}

// EQResponseDB predicts the implemented TPT filter response from its actual coefficients.
// This mathematical response is useful for regularized fitting, not hardware certification.
func EQResponseDB(sampleRate, frequency float64, enabled bool, bands [NumEQBands]BandParams) float64 {
	if !enabled || !finite(sampleRate) || !finite(frequency) || sampleRate < 8000 || frequency <= 0 || frequency >= sampleRate/2 {
		return 0
	}
	omega := 2 * math.Pi * frequency / sampleRate
	z := complex(math.Cos(omega), math.Sin(omega))
	response := complex(1, 0)
	for _, band := range bands {
		c := computeBandCoeffs(sampleRate, band)
		if !c.active {
			continue
		}
		// The two TPT integrator states form x[n+1]=A*x[n]+B*u[n].
		a00, a01 := 2*c.a1-1, -2*c.a2
		a10, a11 := 2*c.a2, 1-2*c.a3
		b0, b1 := 2*c.a2, 2*c.a3
		determinant := (z-complex(a00, 0))*(z-complex(a11, 0)) - complex(a01*a10, 0)
		if real(determinant) == 0 && imag(determinant) == 0 {
			continue
		}
		state0 := (complex(b0, 0)*(z-complex(a11, 0)) + complex(a01*b1, 0)) / determinant
		state1 := ((z-complex(a00, 0))*complex(b1, 0) + complex(a10*b0, 0)) / determinant
		v1 := complex(c.a1, 0)*state0 + complex(c.a2, 0)*(1-state1)
		v2 := state1 + complex(c.a2, 0)*state0 + complex(c.a3, 0)*(1-state1)
		response *= complex(c.m0, 0) + complex(c.m1, 0)*v1 + complex(c.m2, 0)*v2
	}
	magnitude := math.Hypot(real(response), imag(response))
	if magnitude < 1e-12 {
		return -240
	}
	return 20 * math.Log10(magnitude)
}
