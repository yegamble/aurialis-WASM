package dsp

import (
	"fmt"
	"math"
	"reflect"
	"testing"
)

func TestAlgorithmVersionLegacyCompatibility(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := DefaultParams()
		p.InputGainDB = 2
		p.Bands[1].GainDB = -2
		p.Compressor.ThresholdDB, p.Compressor.Ratio = -20, 2
		p.Saturation.Amount = 20
		p.Stereo.MonoBass = true
		p.Limiter.Enabled = true
		p.DitherBits = 16
		inL, inR := generateToneStereo(rate, 997, .4, .05, .2)
		base := NewEngine(rate)
		base.SetParams(p)
		wantL, wantR := make([]float32, len(inL)), make([]float32, len(inR))
		base.ProcessBlock(inL, inR, wantL, wantR)
		for _, version := range []uint32{0, 1} {
			p.AlgorithmVersion = version
			e := NewEngine(rate)
			e.SetParams(p)
			gotL, gotR := make([]float32, len(inL)), make([]float32, len(inR))
			e.ProcessBlock(inL, inR, gotL, gotR)
			if !reflect.DeepEqual(gotL, wantL) || !reflect.DeepEqual(gotR, wantR) || e.AlgorithmVersion() != 1 {
				t.Fatalf("rate %g version %d changed legacy PCM", rate, version)
			}
		}
	}
}

func TestAlgorithmVersionRejectionPreservesHistory(t *testing.T) {
	for _, version := range []uint32{2, 3, math.MaxUint32} {
		e, reference := NewEngine(48000), NewEngine(48000)
		p := DefaultParams()
		p.Bands[2].GainDB, p.Saturation.Amount = 3, 30
		e.SetParams(p)
		reference.SetParams(p)
		var in, got, want, scratch [128]float32
		for i := range in {
			in[i] = float32(i%17-8) / 32
		}
		e.ProcessBlock(in[:], in[:], got[:], scratch[:])
		reference.ProcessBlock(in[:], in[:], want[:], scratch[:])
		invalid := p
		invalid.AlgorithmVersion, invalid.InputGainDB = version, 12
		if ValidateParams(invalid) == nil {
			t.Fatal("accepted unimplemented algorithm")
		}
		e.SetParams(invalid)
		if e.Params() != p {
			t.Fatal("rejected version changed settings")
		}
		if _, err := DecodeParamsJSON([]byte(fmt.Sprintf(`{"algorithmVersion":%d,"inputGainDb":12}`, version)), p); err == nil {
			t.Fatal("JSON accepted unimplemented algorithm")
		}
		e.ProcessBlock(in[:], in[:], got[:], scratch[:])
		reference.ProcessBlock(in[:], in[:], want[:], scratch[:])
		if got != want {
			t.Fatal("rejected version changed processing history")
		}
	}
	for _, payload := range []string{`{"algorithmVersion":-1}`, `{"algorithmVersion":1.5}`, `{"algorithmVersion":null}`} {
		if _, err := DecodeParamsJSON([]byte(payload), DefaultParams()); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
}

func TestLegacyLatencyDrainAndAllocationContract(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, frames := range []int{1, 127, 128, 129, 4096} {
			t.Run(fmt.Sprintf("%.0f/%d", rate, frames), func(t *testing.T) {
				e := NewEngine(rate)
				p := DefaultParams()
				p.InputGainDB = 1
				p.Bands[2].GainDB = 2
				p.Compressor.ThresholdDB, p.Compressor.Ratio = -20, 2
				p.Saturation.Amount, p.Stereo.WidthPct = 20, 125
				p.Stereo.MonoBass, p.Limiter.Enabled = true, true
				e.SetParams(p)
				in, left, right := make([]float32, frames), make([]float32, frames), make([]float32, frames)
				in[len(in)-1] = .2
				e.ProcessBlock(in, in, left, right)
				if e.LatencyFrames() != 0 {
					t.Fatal("v1 reported artificial delay")
				}
				beforeL, beforeR := append([]float32(nil), left...), append([]float32(nil), right...)
				if e.Drain(left, right) != 0 || e.Drain(nil, right) != 0 || !reflect.DeepEqual(left, beforeL) || !reflect.DeepEqual(right, beforeR) {
					t.Fatal("v1 drain emitted or changed output")
				}
				if allocations := testing.AllocsPerRun(10, func() { e.ProcessBlock(in, in, left, right); e.Drain(left, right) }); allocations != 0 {
					t.Fatalf("processing allocated %g", allocations)
				}
				e.Reset()
				clear(in)
				e.ProcessBlock(in, in, left, right)
				for _, v := range left {
					if v != 0 {
						t.Fatal("reset leaked earlier audio")
					}
				}
			})
		}
	}
}
