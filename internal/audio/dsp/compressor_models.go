package dsp

import "math"

// Each compressor topology supplies its own level detector, transfer curve and
// program-dependent release. They share the attack/release gain smoother
// (Engine.compEnvDB), so switching topology mid-program moves the applied gain
// continuously. The models are behavioral, not circuit emulations:
//
//   - Optical: 5 ms peak sensing plus a slow second release stage whose
//     recovery lengthens (0.5–3.5 s) with sustained reduction, like a
//     light-dependent resistor that stays "exposed" after heavy work.
//   - Variable-mu: averaged detector and a progressive ratio that starts
//     gentle near threshold and reaches the set ratio only on loud material.
//   - FET: 0.5 ms peak sensing that catches transients; fast auto release.
//   - VCA: linked RMS sensing; auto release is fast for sparse peaks and slow
//     for dense material, chosen by the signal's crest factor.
//
// Averaging detectors are sine-calibrated, so a steady tone at the threshold
// reads the same level on every topology and presets keep their loudness.
type compModelState struct {
	level, power, crest, memory float64
	opticalSlowDB, exposure     float64
}

type compModelCoeffs struct {
	detector, average, crest, memory   float64
	autoFast, autoSlow                 float64
	opticalSlowAttack, opticalExposure float64
	opticalSlowMin, opticalSlowMax     float64
}

const (
	// Mean of a full-wave rectified sine is 2/pi of its peak.
	rectifiedSineToPeakDB = 3.9223
	// RMS of a sine is 1/sqrt(2) of its peak.
	rmsSineToPeakDB = 3.0103
)

// pole63 is a one-pole coefficient reaching 63.2% in ms; detector and memory
// constants use it. User attack/release times keep the 91.8% convention.
func pole63(rate, ms float64) float64 { return math.Exp(-1 / (ms * .001 * rate)) }

func pole918(rate, ms float64) float64 { return math.Exp(-2.5 / (ms * .001 * rate)) }

func prepareCompModel(rate float64, topology CompTopology) compModelCoeffs {
	switch topology {
	case CompVariableMu:
		return compModelCoeffs{average: pole63(rate, 2), memory: pole63(rate, 500), autoFast: pole918(rate, 80), autoSlow: pole918(rate, 1000)}
	case CompFET:
		return compModelCoeffs{detector: pole63(rate, .5), memory: pole63(rate, 80), autoFast: pole918(rate, 40), autoSlow: pole918(rate, 250)}
	case CompVCA:
		return compModelCoeffs{detector: pole63(rate, 25), average: pole63(rate, 5), crest: pole63(rate, 50), autoFast: pole918(rate, 60), autoSlow: pole918(rate, 600)}
	case CompOptical:
		fallthrough
	default:
		return compModelCoeffs{
			detector: pole63(rate, 5), autoFast: pole918(rate, 60), autoSlow: pole918(rate, 60),
			opticalSlowAttack: pole63(rate, 350), opticalExposure: pole63(rate, 1200),
			opticalSlowMin: pole63(rate, 500), opticalSlowMax: pole63(rate, 3500),
		}
	}
}

func softKneeGR(levelDB float64, c *CompressorParams) float64 {
	if c.Ratio <= 1.0001 {
		return 0
	}
	slope := 1.0 - 1.0/c.Ratio
	over := levelDB - c.ThresholdDB
	knee := c.KneeDB
	if knee > 0.01 && over > -knee*0.5 && over < knee*0.5 {
		x := over + knee*0.5
		return slope * x * x / (2.0 * knee)
	}
	if over > 0 {
		return slope * over
	}
	return 0
}

// variableMuGR lets the ratio grow from 1:1 at (threshold - knee) towards the
// set ratio as the level rises, instead of switching slope at a knee.
func variableMuGR(levelDB float64, c *CompressorParams) float64 {
	if c.Ratio <= 1.0001 {
		return 0
	}
	distance := levelDB - (c.ThresholdDB - c.KneeDB)
	if distance <= 0 {
		return 0
	}
	ratio := c.Ratio
	if c.KneeDB > 0 {
		ratio = 1 + (c.Ratio-1)*distance/(distance+c.KneeDB)
	}
	return distance * (1 - 1/ratio)
}

func followPeak(env, peak, release float64) float64 {
	if peak >= env {
		return peak
	}
	return release*env + (1-release)*peak
}

// target returns the static reduction for this sample and the release
// coefficient the shared smoother uses when reduction is falling. Program
// memory follows the applied reduction, so it outlasts the detector.
func (s *compModelState) target(l, r float64, c *CompressorParams, k *compModelCoeffs, release, appliedGR float64) (float64, float64) {
	switch c.Topology {
	case CompVariableMu:
		s.level = k.average*s.level + (1-k.average)*math.Max(math.Abs(l), math.Abs(r))
		gr := variableMuGR(linToDB(s.level)+rectifiedSineToPeakDB, c)
		if c.AutoRelease {
			s.memory = k.memory*s.memory + (1-k.memory)*math.Min(1, appliedGR/12)
			release = k.autoFast + s.memory*(k.autoSlow-k.autoFast)
		}
		return gr, release
	case CompVCA:
		power := math.Max(l*l, r*r)
		s.power = k.average*s.power + (1-k.average)*power
		s.level = followPeak(s.level, math.Sqrt(power), k.detector)
		gr := softKneeGR(10*math.Log10(math.Max(s.power, 1e-24))+rmsSineToPeakDB, c)
		if c.AutoRelease {
			crestDB := 10 * math.Log10(math.Max(s.level*s.level, 1e-24)/math.Max(s.power, 1e-24))
			s.crest = k.crest*s.crest + (1-k.crest)*math.Min(1, math.Max(0, (crestDB-rmsSineToPeakDB)/12))
			release = k.autoSlow + s.crest*(k.autoFast-k.autoSlow)
		}
		return gr, release
	case CompFET:
		s.level = followPeak(s.level, math.Max(math.Abs(l), math.Abs(r)), k.detector)
		gr := softKneeGR(linToDB(s.level), c)
		if c.AutoRelease {
			s.memory = k.memory*s.memory + (1-k.memory)*math.Min(1, appliedGR/12)
			release = k.autoFast + s.memory*(k.autoSlow-k.autoFast)
		}
		return gr, release
	case CompOptical:
		fallthrough
	default:
		s.level = followPeak(s.level, math.Max(math.Abs(l), math.Abs(r)), k.detector)
		gr := softKneeGR(linToDB(s.level), c)
		if c.AutoRelease {
			release = k.autoFast
		}
		return gr, release
	}
}

// opticalSlowStage adds the second, exposure-dependent release on top of the
// fast reduction. Exposure and slow reduction are separate states, so heavy
// sustained work leaves a long tail while brief peaks recover quickly.
func (s *compModelState) opticalSlowStage(targetGR, fastGR float64, k *compModelCoeffs) float64 {
	s.exposure = k.opticalExposure*s.exposure + (1-k.opticalExposure)*math.Min(1, targetGR/12)
	coeff := k.opticalSlowMin + s.exposure*(k.opticalSlowMax-k.opticalSlowMin)
	if targetGR > s.opticalSlowDB {
		coeff = k.opticalSlowAttack
	}
	s.opticalSlowDB = coeff*s.opticalSlowDB + (1-coeff)*targetGR
	return math.Max(fastGR, s.exposure*s.opticalSlowDB)
}
