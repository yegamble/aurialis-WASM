package dsp

import (
	"context"
	_ "embed"
	"encoding/binary"
	"errors"
	"math"
)

const (
	studioFinalEstimateName = "aurialis-finite-hann4097-4x-candidate1"
	studioFinalEstimateHash = "f4522b41785dc113280632a1c6797fedd3dfc61a553626666428c88357791ddd"
)

// These exact little-endian binary64 bytes freeze this private estimate. The
// original Hann-sinc formula is tested separately. They are not Annex2's filter.
//
//go:embed studio_final_coefficients.bin
var studioFinalCoefficientBytes string

func prepareStudioFinalKernel() studioPostGuardKernel {
	var kernel studioPostGuardKernel
	for i := range kernel.quarter {
		kernel.quarter[i] = math.Float64frombits(binary.LittleEndian.Uint64([]byte(studioFinalCoefficientBytes[i*8 : (i+1)*8])))
	}
	for i := range kernel.half {
		start := (1024 + i) * 8
		kernel.half[i] = math.Float64frombits(binary.LittleEndian.Uint64([]byte(studioFinalCoefficientBytes[start : start+8])))
	}
	return kernel
}

// This report describes only a named finite4x estimate. In particular it does
// not certify the ideal-sinc reconstruction of an arbitrary finite record.
type studioFinalPCMReport struct {
	Estimator, CoefficientSHA256 string
	Frames, BitDepth, Passes     int
	BeforePeak, AfterPeak        float64
	CorrectionDB                 float64
}

func validateStudioFinalLayout(ctx context.Context, left, right []float32) error {
	if ctx == nil || len(left) == 0 || len(left) != len(right) || len(left) > 16*1024*1024 {
		return errors.New("invalid private final PCM layout")
	}
	return ctx.Err()
}

// measureStudioFinite4x defines an exact finite reconstruction convention:
// phase0 is the original sample; phase1/3 use the frozen1024 quarter/reversed
// quarter taps, phase2 the512 mirrored half taps. Each phase has unity DC gain.
// The whole input [0,N) is retained, with zeros outside it. All1023 filter-tail
// input clocks are processed, including reconstructed values outside [0,N).
// The peak is max absolute amplitude over both channels and all four phases.
// No polynomial refinement, windowing of the PCM, rate conversion or trim is
// applied. Scratch is fixed; cancellation is checked every4096 input clocks.
func measureStudioFinite4x(ctx context.Context, left, right []float32) (float64, error) {
	if err := validateStudioFinalLayout(ctx, left, right); err != nil {
		return 0, err
	}
	kernel := prepareStudioFinalKernel()
	var history [2][1024]float64
	cursor, peak := 0, 0.0
	for frame := 0; frame < len(left)+1023; frame++ {
		if frame%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
		}
		l, r := 0.0, 0.0
		if frame < len(left) {
			l, r = float64(left[frame]), float64(right[frame])
			if !finite(l) || !finite(r) {
				return 0, errors.New("nonfinite private final PCM")
			}
		}
		history[0][cursor], history[1][cursor] = l, r
		for ch := range history {
			peak = math.Max(peak, math.Abs(history[ch][(cursor-512)&1023]))
			quarter, half, threeQuarter := 0.0, 0.0, 0.0
			for tap, coefficient := range kernel.half {
				front, back := history[ch][(cursor-tap)&1023], history[ch][(cursor-1023+tap)&1023]
				a, b := kernel.quarter[tap], kernel.quarter[1023-tap]
				quarter += a*front + b*back
				threeQuarter += b*front + a*back
				half += coefficient * (front + back)
			}
			peak = math.Max(peak, math.Max(math.Abs(quarter), math.Max(math.Abs(half), math.Abs(threeQuarter))))
		}
		cursor = (cursor + 1) & 1023
	}
	return peak, ctx.Err()
}

// prepareStudioFinalPCM is an offline-only private comparison foundation. The
// caller supplies exact final samples before dither, after latency compensation;
// no later trimming is allowed under this report. Only measured over-ceiling
// output receives explicit reported gain. Every correction starts from that
// immutable source, applies deterministic TPDF once, and remeasures its final
// quantized float32 samples including all zero-extended reconstruction tails.
// This function is never selected by public Engine or native export.
func prepareStudioFinalPCM(ctx context.Context, left, right []float32, bits int, ceilingDB float64) ([]float32, []float32, studioFinalPCMReport, error) {
	var report studioFinalPCMReport
	if err := validateStudioFinalLayout(ctx, left, right); err != nil {
		return nil, nil, report, err
	}
	if (bits != 0 && bits != 16 && bits != 24) || !finite(ceilingDB) || ceilingDB < -12 || ceilingDB > 0 {
		return nil, nil, report, errors.New("invalid private final PCM format or ceiling")
	}
	before, err := measureStudioFinite4x(ctx, left, right)
	if err != nil {
		return nil, nil, report, err
	}
	report = studioFinalPCMReport{Estimator: studioFinalEstimateName, CoefficientSHA256: studioFinalEstimateHash, Frames: len(left), BitDepth: bits, BeforePeak: before}
	ceiling, target, gain := dbToLin(ceilingDB), dbToLin(ceilingDB-.001), 1.0
	if before > ceiling {
		gain = target / before
	}
	outL, outR := make([]float32, len(left)), make([]float32, len(right))
	for pass := range 4 {
		// Repeating a correction cannot accumulate noise from prior attempts.
		quantizer := Engine{prngState: 0x9E3779B97F4A7C15}
		for i := range left {
			if i%4096 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, nil, report, err
				}
			}
			l, r := float64(left[i])*gain, float64(right[i])*gain
			if bits != 0 {
				l, r = quantizer.applyTPDFDither(l, bits), quantizer.applyTPDFDither(r, bits)
			}
			outL[i], outR[i] = float32(l), float32(r)
		}
		after, err := measureStudioFinite4x(ctx, outL, outR)
		if err != nil {
			return nil, nil, report, err
		}
		report.Passes, report.AfterPeak, report.CorrectionDB = pass+1, after, 20*math.Log10(gain)
		if after <= ceiling {
			return outL, outR, report, nil
		}
		gain *= target / after
	}
	return nil, nil, report, errors.New("private final PCM verification failed; no output certified")
}
