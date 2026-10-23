package dsp

import (
	"errors"
	"math"
)

// Private studio primitives are calibration candidates, not public algorithm 2
// or hardware emulations. Legacy Engine processing never calls these helpers.
// Attack/release use 63.2% one-pole time constants, expressed in milliseconds.
type studioCompressor struct {
	sampleRate                        float64
	params                            CompressorParams
	sidechain                         svfCoeffs
	sidechainState                    [2][2]svfState
	optical                           studioOpticalState
	opticalCoeffs                     studioOpticalCoeffs
	variableMu                        studioMuState
	variableMuCoeffs                  studioMuCoeffs
	vca                               studioVCAState
	vcaCoeffs                         studioVCACoeffs
	fet                               studioFETState
	fetCoeffs                         studioFETCoeffs
	gainDB, reductionDB               float64
	transitionFromDB                  float64
	transitionFromReductionDB         float64
	transitionFrame, transitionLength int
}

func prepareStudioCompressor(rate float64, params CompressorParams) (studioCompressor, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 {
		return studioCompressor{}, errors.New("invalid studio compressor sample rate")
	}
	chain := DefaultParams()
	chain.Compressor = params
	if err := ValidateParams(chain); err != nil {
		return studioCompressor{}, err
	}
	switch params.Topology {
	case CompOptical:
		// Require the declared model range; never silently clamp the user's knee.
		if params.KneeDB < 6 {
			return studioCompressor{}, errors.New("studio optical knee must be at least 6 dB")
		}
	case CompVariableMu, CompVCA:
	case CompFET:
		if params.KneeDB > 6 {
			return studioCompressor{}, errors.New("studio FET knee must not exceed 6 dB")
		}
	default:
		return studioCompressor{}, errors.New("unsupported studio compressor topology")
	}
	c := studioCompressor{sampleRate: rate, params: params, sidechain: computeButterworthSVF(rate, params.SidechainHPFHz)}
	c.opticalCoeffs = prepareStudioOptical(rate, params)
	c.variableMuCoeffs = prepareStudioMu(rate, params)
	c.vcaCoeffs = prepareStudioVCA(rate, params)
	c.fetCoeffs = prepareStudioFET(rate, params)
	c.resetHistory()
	return c, nil
}

// Updates preserve active model memory. A topology/bypass edit clears the old
// detector and moves the applied gain continuously to the new model over 5 ms.
func (c *studioCompressor) setParams(params CompressorParams) error {
	if params == c.params {
		return nil
	}
	next, err := prepareStudioCompressor(c.sampleRate, params)
	if err != nil {
		return err
	}
	if params.Enabled && c.params.Enabled && params.Ratio > 1 && c.params.Ratio > 1 && params.Topology == c.params.Topology {
		next.optical = c.optical
		next.variableMu = c.variableMu
		next.vca = c.vca
		next.fet = c.fet
		if params.SidechainHPFHz == c.params.SidechainHPFHz {
			next.sidechainState = c.sidechainState
		}
	}
	next.gainDB, next.reductionDB = c.gainDB, c.reductionDB
	next.transitionFromDB = c.gainDB
	next.transitionFromReductionDB = c.reductionDB
	next.transitionLength = int(math.Ceil(.005 * c.sampleRate))
	*c = next
	return nil
}

func (c *studioCompressor) resetHistory() {
	c.sidechainState = [2][2]svfState{}
	c.optical = studioOpticalState{}
	c.variableMu = studioMuState{}
	c.vca = studioVCAState{}
	c.fet = studioFETState{}
	c.reductionDB = 0
	c.gainDB = 0
	if c.params.Enabled {
		c.gainDB = c.params.MakeupDB
	}
	c.transitionFromDB = c.gainDB
	c.transitionFromReductionDB = 0
	c.transitionFrame, c.transitionLength = 0, 0
}

func studioSoftKnee(levelDB float64, params CompressorParams) float64 {
	if params.Ratio == 1 {
		return 0
	}
	over := levelDB - params.ThresholdDB
	slope := 1 - 1/params.Ratio
	if params.KneeDB > 0 && over > -params.KneeDB/2 && over < params.KneeDB/2 {
		inside := over + params.KneeDB/2
		return slope * inside * inside / (2 * params.KneeDB)
	}
	return math.Max(0, slope*over)
}

func studioPole(rate, milliseconds float64) float64 {
	return math.Exp(-1 / (rate * milliseconds * .001))
}

func (c *studioCompressor) process(left, right float64) (float64, float64) {
	left, right = sanitizeSample(left), sanitizeSample(right)
	if !c.params.Enabled && c.transitionLength == 0 {
		return left, right
	}
	targetGainDB, targetReductionDB := 0.0, 0.0
	if c.params.Enabled {
		scLeft, scRight := left, right
		if c.params.SidechainHPFHz > 10 {
			for stage := range 2 {
				_, scLeft = processSVFLowHigh(c.sidechain, &c.sidechainState[0][stage], scLeft)
				_, scRight = processSVFLowHigh(c.sidechain, &c.sidechainState[1][stage], scRight)
			}
		}
		gr := 0.0
		switch c.params.Topology {
		case CompOptical:
			gr = c.optical.process(scLeft, scRight, c.params, c.opticalCoeffs)
		case CompVariableMu:
			gr = c.variableMu.process(scLeft, scRight, c.params, c.variableMuCoeffs)
		case CompVCA:
			gr = c.vca.process(scLeft, scRight, c.params, c.vcaCoeffs)
		case CompFET:
			gr = c.fet.process(scLeft, scRight, c.params, c.fetCoeffs)
		}
		if c.params.Ratio == 1 {
			gr = 0
		}
		targetReductionDB = gr
		targetGainDB = c.params.MakeupDB - gr
	}
	c.gainDB = targetGainDB
	c.reductionDB = targetReductionDB
	if c.transitionLength > 0 {
		c.transitionFrame++
		fraction := float64(c.transitionFrame) / float64(c.transitionLength)
		c.gainDB = c.transitionFromDB + fraction*(targetGainDB-c.transitionFromDB)
		c.reductionDB = c.transitionFromReductionDB + fraction*(targetReductionDB-c.transitionFromReductionDB)
		if c.transitionFrame >= c.transitionLength {
			c.transitionFrame, c.transitionLength = 0, 0
		}
	}
	if c.gainDB == 0 {
		return left, right
	}
	gain := dbToLin(c.gainDB)
	return sanitizeSample(left * gain), sanitizeSample(right * gain)
}
