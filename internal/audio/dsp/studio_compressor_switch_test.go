package dsp

import (
	"math"
	"testing"
)

func TestStudioRapidTopologyChangesPreserveLastAppliedGainAndMeter(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		c := mustStudioCompressor(t, rate, studioTestParams(CompOptical))
		runStudioDC(&c, .5, 1)
		for range 8 {
			for _, topology := range []CompTopology{CompVariableMu, CompVCA, CompFET, CompOptical} {
				p := studioTestParams(topology)
				gainBefore, reductionBefore := c.gainDB, c.reductionDB
				if err := c.setParams(p); err != nil {
					t.Fatal(err)
				}
				if c.gainDB != gainBefore || c.reductionDB != reductionBefore {
					t.Fatal("parameter transaction changed last-applied gain or telemetry before a sample")
				}
				for range 16 {
					prior := c.gainDB
					l, r := c.process(1, -.5)
					if !finite(l) || !finite(r) || r != -.5*l || !finite(c.reductionDB) || c.reductionDB < 0 || math.Abs(c.gainDB-prior) > 1 {
						t.Fatal("rapid topology edit broke linked/finite bounded transition on declared DC fixture")
					}
				}
			}
		}
		p := studioTestParams(CompFET)
		if err := c.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range int(rate * .01) {
			l, r := c.process(0, 0)
			if l != 0 || r != 0 {
				t.Fatal("topology transition replayed prior audio into silence")
			}
		}
		if c.reductionDB != 0 {
			t.Fatal("topology transition retained the stopped model's reduction")
		}
	}
}

func TestStudioAllTopologiesMakeupAndBypassMeterSemantics(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, topology := range []CompTopology{CompOptical, CompVariableMu, CompVCA, CompFET} {
			p := studioTestParams(topology)
			p.Ratio = 1
			c := mustStudioCompressor(t, rate, p)
			p.MakeupDB = 6
			if err := c.setParams(p); err != nil {
				t.Fatal(err)
			}
			for range int(rate * .01) {
				c.process(.25, -.125)
				if c.reductionDB != 0 {
					t.Fatal("unity-ratio makeup ramp reported reduction")
				}
			}
			p.Enabled = false
			if err := c.setParams(p); err != nil {
				t.Fatal(err)
			}
			for range int(rate * .01) {
				c.process(.25, -.125)
				if c.reductionDB != 0 {
					t.Fatal("makeup bypass reported reduction")
				}
			}
			if l, r := c.process(.25, -.125); l != .25 || r != -.125 {
				t.Fatal("disabled topology retained makeup gain")
			}
		}
	}
}
