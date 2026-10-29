package main

import (
	"fmt"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// The changed nonlinear spectrum must still satisfy the independent long-sinc
// output-ceiling oracle, including the last FIR-backed frames of an abrupt EOF.
func TestOversampledExportsHoldTheCeilingAgainstTheLongSincReference(t *testing.T) {
	characters := []dsp.SatCharacter{dsp.SatWarm, dsp.SatThick, dsp.SatCrisp, dsp.SatClean, dsp.SatTube, dsp.SatTape, dsp.SatTransformer}
	for _, rate := range []float64{44100, 48000, 96000} {
		for index, character := range characters {
			if raceEnabled && (rate != 48000 || (character != dsp.SatCrisp && character != dsp.SatTube)) {
				continue
			}
			for _, torture := range []bool{false, true} {
				t.Run(fmt.Sprintf("%.0f/%s/torture=%t", rate, character, torture), func(t *testing.T) {
					left, right := denseMix(rate, 1)
					if torture {
						left, right = nyquistTorture(rate, 1)
					}
					left[len(left)-1], right[len(right)-1] = .95, -.85
					p := heaviestLiveParams(dsp.OversampledAlgorithmVersion, character)
					p.Saturation.Amount = 100
					p.Limiter.CeilingDBTP = -1 - .5*float64(index%3)
					outL, outR, metrics := dsp.RenderBuffer(left, right, rate, p)
					checkCeiling(t, outL, outR, rate, p.Limiter.CeilingDBTP, metrics)
				})
			}
		}
	}
}
