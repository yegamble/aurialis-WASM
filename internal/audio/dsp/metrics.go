package dsp

import (
	"context"
	"errors"
	"math"
)

// Metrics contains diagnostic acoustic estimates. The legacy LUFS/DBTP field
// names do not imply BS.1770 compliance: loudness is ungated approximate weighting
// and inter-sample peaks use cubic interpolation.
type Metrics struct {
	IntegratedLUFS     float64 `json:"integratedLufs"`
	ShortTermLUFS      float64 `json:"shortTermLufs"`
	TruePeakDBTP       float64 `json:"truePeakDbtp"`
	SamplePeakDBFS     float64 `json:"samplePeakDbfs"`
	DynamicRangeDB     float64 `json:"dynamicRangeDb"`
	Correlation        float64 `json:"correlation"`
	LowBassCorrelation float64 `json:"lowBassCorrelation"`
	DCLeftDBFS         float64 `json:"dcLeftDbfs"`
	DCRightDBFS        float64 `json:"dcRightDbfs"`
	ClippingSamples    int     `json:"clippingSamples"`
	GainReductionDB    float64 `json:"gainReductionDb"`
}

// MeasureStereo computes approximate weighted loudness, cubic inter-sample peak,
// crest factor, uncentered stereo correlation, low-bass correlation, and DC offset.
func MeasureStereo(left, right []float32, sampleRate float64) Metrics {
	m, _ := measureStereoContext(context.Background(), left, right, sampleRate)
	return m
}

func measureStereoContext(ctx context.Context, left, right []float32, sampleRate float64) (Metrics, error) {
	n := len(left)
	if len(right) < n {
		n = len(right)
	}
	if n == 0 {
		return Metrics{
			IntegratedLUFS:  -70.0,
			ShortTermLUFS:   -70.0,
			TruePeakDBTP:    -120.0,
			SamplePeakDBFS:  -120.0,
			DynamicRangeDB:  0.0,
			Correlation:     1.0,
			DCLeftDBFS:      -120.0,
			DCRightDBFS:     -120.0,
			ClippingSamples: 0,
		}, nil
	}
	if !finite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0 {
		sampleRate = 48000.0
	}

	// K-weighting pre-filter (High-shelf +4 dB above 1.5 kHz + 60 Hz RLB high-pass)
	kwShelf := computeBandCoeffs(sampleRate, BandParams{
		FreqHz:  1681.97,
		GainDB:  4.0,
		Q:       0.7071,
		Type:    FilterHighShelf,
		Enabled: true,
	})
	kwHPF := computeButterworthSVF(sampleRate, 38.135)
	var kwShelfL, kwShelfR svfState
	var kwHPFL, kwHPFR svfState

	// Low-bass (<110 Hz) correlation filter (4th-order Butterworth LP)
	lbFilter := computeButterworthSVF(sampleRate, 110.0)
	var lbL1, lbL2, lbR1, lbR2 svfState

	var sumSqK float64
	var sumSqRaw float64
	var maxSamplePeak float64
	var maxTruePeak float64
	var sumL, sumR float64
	var corrLL, corrRR, corrLR float64
	var lbLL, lbRR, lbLR float64
	var prevL [3]float64
	var prevR [3]float64
	var clipping int

	windowLen := int(sampleRate * 0.4)
	if windowLen < 64 {
		windowLen = 64
	}
	var winEnergy float64
	var maxShortTermEnergy float64
	var p95PeakSq float64
	winCount := 0

	for i := 0; i < n; i++ {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return Metrics{}, err
			}
		}
		l := sanitizeSample(float64(left[i]))
		r := sanitizeSample(float64(right[i]))

		sumL += l
		sumR += r

		absL := math.Abs(l)
		absR := math.Abs(r)
		if absL >= 0.9999 || absR >= 0.9999 {
			clipping++
		}
		sp := math.Max(absL, absR)
		if sp > maxSamplePeak {
			maxSamplePeak = sp
		}

		tpL := estimateTruePeak4x(prevL[0], prevL[1], prevL[2], l)
		tpR := estimateTruePeak4x(prevR[0], prevR[1], prevR[2], r)
		prevL[0], prevL[1], prevL[2] = prevL[1], prevL[2], l
		prevR[0], prevR[1], prevR[2] = prevR[1], prevR[2], r
		tp := math.Max(tpL, tpR)
		if tp > maxTruePeak {
			maxTruePeak = tp
		}

		corrLL += l * l
		corrRR += r * r
		corrLR += l * r
		sumSqRaw += 0.5 * (l*l + r*r)

		// Low-bass (<110 Hz) correlation after settling first 256 samples
		lowL1, _ := processSVFLowHigh(lbFilter, &lbL1, l)
		lowL2, _ := processSVFLowHigh(lbFilter, &lbL2, lowL1)
		lowR1, _ := processSVFLowHigh(lbFilter, &lbR1, r)
		lowR2, _ := processSVFLowHigh(lbFilter, &lbR2, lowR1)
		if i >= 256 || n < 512 {
			lbLL += lowL2 * lowL2
			lbRR += lowR2 * lowR2
			lbLR += lowL2 * lowR2
		}

		// K-weighted energy
		kl := processSVF(kwShelf, &kwShelfL, l)
		_, kl = processSVFLowHigh(kwHPF, &kwHPFL, kl)
		kr := processSVF(kwShelf, &kwShelfR, r)
		_, kr = processSVFLowHigh(kwHPF, &kwHPFR, kr)

		eSample := 0.5 * (kl*kl + kr*kr)
		sumSqK += eSample
		winEnergy += eSample

		if (i+1)%windowLen == 0 || i == n-1 {
			blockItems := windowLen
			if i == n-1 && (i+1)%windowLen != 0 {
				blockItems = (i + 1) % windowLen
			}
			meanBlock := winEnergy / float64(blockItems)
			if meanBlock > maxShortTermEnergy {
				maxShortTermEnergy = meanBlock
			}
			p95PeakSq += meanBlock
			winCount++
			winEnergy = 0
		}
	}

	meanK := sumSqK / float64(n)
	intLUFS := -70.0
	if meanK > 1e-12 {
		intLUFS = -0.691 + 10.0*math.Log10(meanK)
	}
	stLUFS := intLUFS
	if maxShortTermEnergy > 1e-12 {
		stLUFS = -0.691 + 10.0*math.Log10(maxShortTermEnergy)
	}

	tpDB := linToDB(maxTruePeak)
	spDB := linToDB(maxSamplePeak)

	meanRaw := sumSqRaw / float64(n)
	rmsDB := linToDB(math.Sqrt(meanRaw))
	drDB := 0.0
	if maxTruePeak > 1e-9 && meanRaw > 1e-12 {
		drDB = math.Max(1.0, tpDB-rmsDB)
	}
	_ = p95PeakSq
	_ = winCount

	corr := 1.0
	denom := math.Sqrt(corrLL * corrRR)
	if denom > 1e-12 {
		corr = corrLR / denom
		if corr > 1.0 {
			corr = 1.0
		} else if corr < -1.0 {
			corr = -1.0
		}
	}

	lbCorr := 1.0
	lbDenom := math.Sqrt(lbLL * lbRR)
	if lbDenom > 1e-12 {
		lbCorr = lbLR / lbDenom
		if lbCorr > 1.0 {
			lbCorr = 1.0
		} else if lbCorr < -1.0 {
			lbCorr = -1.0
		}
	}

	dcL := linToDB(math.Abs(sumL / float64(n)))
	dcR := linToDB(math.Abs(sumR / float64(n)))

	return Metrics{
		IntegratedLUFS:     intLUFS,
		ShortTermLUFS:      stLUFS,
		TruePeakDBTP:       tpDB,
		SamplePeakDBFS:     spDB,
		DynamicRangeDB:     drDB,
		Correlation:        corr,
		LowBassCorrelation: lbCorr,
		DCLeftDBFS:         dcL,
		DCRightDBFS:        dcR,
		ClippingSamples:    clipping,
	}, nil
}

// GoertzelMagnitudeDB computes the exact DFT bin magnitude (in dBFS) at targetFreqHz
// over the given sample slice using a Hann window after filter-settling warmup.
func GoertzelMagnitudeDB(samples []float32, sampleRate, targetFreqHz float64) float64 {
	n := len(samples)
	if n < 2 || !finite(sampleRate) || !finite(targetFreqHz) || sampleRate <= 0 || targetFreqHz <= 0 {
		return -240.0
	}
	// Skip initial transient warmup (up to 10% of buffer)
	start := n / 10
	windowSamples := samples[start:]
	m := len(windowSamples)
	if m < 16 {
		windowSamples = samples
		m = n
	}

	omega := 2.0 * math.Pi * targetFreqHz / sampleRate
	coeff := 2.0 * math.Cos(omega)
	var s1, s2 float64
	var winSum float64

	for i := 0; i < m; i++ {
		// Hann window for side-lobe suppression
		w := 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(m-1)))
		winSum += w
		s0 := float64(windowSamples[i])*w + coeff*s1 - s2
		s2 = s1
		s1 = s0
	}

	power := s1*s1 + s2*s2 - coeff*s1*s2
	if power <= 1e-24 || winSum <= 0 {
		return -240.0
	}
	mag := (2.0 * math.Sqrt(power)) / winSum
	return linToDB(mag)
}

// RenderBuffer runs an offline render with optional approximate loudness
// calibration. It does not guarantee a target loudness or reconstructed peak
// ceiling. Invalid inputs return empty audio; use RenderBufferContext for errors.
func RenderBuffer(inL, inR []float32, sampleRate float64, params Params) ([]float32, []float32, Metrics) {
	left, right, m, _ := RenderBufferContext(context.Background(), inL, inR, sampleRate, params)
	return left, right, m
}

// RenderBufferContext validates a render and checks cancellation at least every
// 4096 frames throughout processing and measurement, including calibration passes.
func RenderBufferContext(ctx context.Context, inL, inR []float32, sampleRate float64, params Params) ([]float32, []float32, Metrics, error) {
	if ctx == nil {
		return nil, nil, Metrics{}, errors.New("render context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Metrics{}, err
	}
	if !finite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 {
		return nil, nil, Metrics{}, errors.New("sample rate must be finite and within 8000–192000 Hz")
	}
	if len(inL) != len(inR) || len(inL) > 16*1024*1024 {
		return nil, nil, Metrics{}, errors.New("render requires equal channel lengths under 16 million frames")
	}
	if err := ValidateParams(params); err != nil {
		return nil, nil, Metrics{}, err
	}
	for i := range inL {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, Metrics{}, err
			}
		}
		if !finite(float64(inL[i])) || !finite(float64(inR[i])) {
			return nil, nil, Metrics{}, errors.New("render input contains non-finite samples")
		}
	}
	n := len(inL)
	if len(inR) < n {
		n = len(inR)
	}
	outL := make([]float32, n)
	outR := make([]float32, n)
	if n == 0 {
		return outL, outR, MeasureStereo(outL, outR, sampleRate), nil
	}

	engine := NewEngine(sampleRate)
	engine.SetParams(params)
	if err := renderBlocks(ctx, engine, inL[:n], inR[:n], outL, outR); err != nil {
		return nil, nil, Metrics{}, err
	}
	grDB := engine.LastGainReductionDB()

	metrics, err := measureStereoContext(ctx, outL, outR, sampleRate)
	if err != nil {
		return nil, nil, Metrics{}, err
	}
	// When Limiter is enabled with a valid TargetLUFS, perform loudness calibration pass
	if params.Limiter.Enabled && !params.Bypass && !params.ABOriginal && params.Limiter.TargetLUFS <= -5.0 && params.Limiter.TargetLUFS >= -30.0 && metrics.IntegratedLUFS > -60.0 {
		deltaLU := params.Limiter.TargetLUFS - metrics.IntegratedLUFS
		// Clamp loudness makeup adjustment to [-12 dB, +14 dB]
		if math.Abs(deltaLU) > 0.15 {
			if deltaLU > 14.0 {
				deltaLU = 14.0
			} else if deltaLU < -12.0 {
				deltaLU = -12.0
			}
			adjParams := params
			adjParams.InputGainDB = math.Max(-36, math.Min(36, adjParams.InputGainDB+deltaLU))
			engine.Reset()
			engine.SetParams(adjParams)
			if err := renderBlocks(ctx, engine, inL[:n], inR[:n], outL, outR); err != nil {
				return nil, nil, Metrics{}, err
			}
			grDB = engine.LastGainReductionDB()
			metrics, err = measureStereoContext(ctx, outL, outR, sampleRate)
			if err != nil {
				return nil, nil, Metrics{}, err
			}

			// Fine trim if compression/limiting shifted LUFS slightly
			remLU := params.Limiter.TargetLUFS - metrics.IntegratedLUFS
			headroomDB := params.Limiter.CeilingDBTP - metrics.TruePeakDBTP - 0.05
			if math.Abs(remLU) > 0.1 && remLU <= headroomDB {
				trimLin := float32(dbToLin(remLU))
				for i := 0; i < n; i++ {
					outL[i] *= trimLin
					outR[i] *= trimLin
				}
				metrics, err = measureStereoContext(ctx, outL, outR, sampleRate)
				if err != nil {
					return nil, nil, Metrics{}, err
				}
			}
		}
	}

	metrics.GainReductionDB = grDB
	return outL, outR, metrics, nil
}

func renderBlocks(ctx context.Context, e *Engine, inL, inR, outL, outR []float32) error {
	for start := 0; start < len(inL); start += 4096 {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := min(start+4096, len(inL))
		e.ProcessBlock(inL[start:end], inR[start:end], outL[start:end], outR[start:end])
	}
	return ctx.Err()
}
