package dsp

import (
	"math"
	"testing"
)

func generateToneStereo(sampleRate, freqHz, ampLin, durationSec, phaseDiffRad float64) ([]float32, []float32) {
	n := int(sampleRate * durationSec)
	left := make([]float32, n)
	right := make([]float32, n)
	for i := 0; i < n; i++ {
		t := float64(i) / sampleRate
		left[i] = float32(ampLin * math.Sin(2.0*math.Pi*freqHz*t))
		right[i] = float32(ampLin * math.Sin(2.0*math.Pi*freqHz*t+phaseDiffRad))
	}
	return left, right
}

func TestBitIdenticalBypassAndZeroAllocs(t *testing.T) {
	const sr = 48000.0
	inL, inR := generateToneStereo(sr, 440.0, 0.5, 0.5, 0.3)
	outL := make([]float32, len(inL))
	outR := make([]float32, len(inR))

	engine := NewEngine(sr)
	engine.ProcessBlock(inL, inR, outL, outR)
	for i := range inL {
		if outL[i] != inL[i] || outR[i] != inR[i] {
			t.Fatalf("neutral chain not bit-identical at sample %d: got (%v,%v), want (%v,%v)", i, outL[i], outR[i], inL[i], inR[i])
		}
	}

	// Activate all modules and verify Bypass=true still yields bit-identical output
	active := DefaultParams()
	active.Bypass = true
	active.InputGainDB = 4.5
	active.Bands[1].GainDB = 6.0
	active.Compressor.ThresholdDB = -20.0
	active.Compressor.Ratio = 4.0
	active.Saturation.Amount = 60.0
	active.Stereo.WidthPct = 145.0
	active.Stereo.MonoBass = true
	active.Limiter.Enabled = true
	engine.SetParams(active)
	engine.ProcessBlock(inL, inR, outL, outR)
	for i := range inL {
		if outL[i] != inL[i] || outR[i] != inR[i] {
			t.Fatalf("bypass=true not bit-identical at sample %d", i)
		}
	}

	// Verify 0 heap allocations per ProcessBlock when all DSP stages are active
	active.Bypass = false
	active.Repair.Enabled = true
	active.Repair.DeEssDB = 4.0
	active.Repair.TransientDB = 2.0
	active.Repair.DeClip = true
	active.DitherBits = 16
	engine.SetParams(active)

	blockL := inL[:512]
	blockR := inR[:512]
	dstL := outL[:512]
	dstR := outR[:512]
	allocs := testing.AllocsPerRun(50, func() {
		engine.ProcessBlock(blockL, blockR, dstL, dstR)
	})
	if allocs > 0 {
		t.Fatalf("expected 0 heap allocations in ProcessBlock, got %v", allocs)
	}
}

func TestFiveBandEQAccuracyAndBandIsolation(t *testing.T) {
	const sr = 48000.0
	const n = 48000 // 1 second
	freqs := [NumEQBands]float64{60.0, 250.0, 1000.0, 4000.0, 12000.0}

	inL := make([]float32, n)
	inR := make([]float32, n)
	amp := dbToLin(-20.0) // -20 dBFS per tone so composite peak < -6 dBFS
	for i := 0; i < n; i++ {
		tm := float64(i) / sr
		var sum float64
		for _, f := range freqs {
			sum += amp * math.Sin(2.0*math.Pi*f*tm)
		}
		inL[i] = float32(sum)
		inR[i] = float32(sum)
	}

	var baseMag [NumEQBands]float64
	for b := 0; b < NumEQBands; b++ {
		baseMag[b] = GoertzelMagnitudeDB(inL, sr, freqs[b])
	}

	for targetBand := 0; targetBand < NumEQBands; targetBand++ {
		for _, targetGain := range []float64{6.0, -6.0} {
			params := DefaultParams()
			params.Bands[targetBand].GainDB = targetGain
			outL, _, _ := RenderBuffer(inL, inR, sr, params)

			for probeBand := 0; probeBand < NumEQBands; probeBand++ {
				gotMag := GoertzelMagnitudeDB(outL, sr, freqs[probeBand])
				delta := gotMag - baseMag[probeBand]
				if probeBand == targetBand {
					if math.Abs(delta-targetGain) > 0.55 {
						t.Errorf("band %d (%v Hz) with gain %+0.1f dB: measured delta %+0.2f dB ( outside +/-0.55 dB)",
							targetBand, freqs[targetBand], targetGain, delta)
					}
				} else {
					if math.Abs(delta) > 0.18 {
						t.Errorf("cross-coupling leak: adjusting band %d (%v Hz) by %+0.1f dB perturbed band %d (%v Hz) by %+0.3f dB",
							targetBand, freqs[targetBand], targetGain, probeBand, freqs[probeBand], delta)
					}
				}
			}
		}
	}
}

func TestCompressorTransferAndSidechainHPF(t *testing.T) {
	const sr = 48000.0
	const n = 48000
	inL := make([]float32, n)
	inR := make([]float32, n)

	lowAmp := dbToLin(-24.0)
	highAmp := dbToLin(-4.0)
	for i := 0; i < n; i++ {
		amp := lowAmp
		if i >= 12000 && i < 36000 {
			amp = highAmp
		}
		v := float32(amp * math.Sin(2.0*math.Pi*1000.0*float64(i)/sr))
		inL[i] = v
		inR[i] = v
	}

	params := DefaultParams()
	params.Compressor.Enabled = true
	params.Compressor.ThresholdDB = -16.0
	params.Compressor.Ratio = 4.0
	params.Compressor.KneeDB = 0.0
	params.Compressor.AttackMS = 10.0
	params.Compressor.ReleaseMS = 60.0
	params.Compressor.SidechainHPFHz = 90.0

	outL, _, _ := RenderBuffer(inL, inR, sr, params)

	// Steady state during -4 dBFS burst (expected GR = (-4 - -16)*(1 - 1/4) = 9.0 dB -> output -13.0 dBFS)
	burstSteady := outL[20000:34000]
	burstMagDB := GoertzelMagnitudeDB(burstSteady, sr, 1000.0)
	expectedOutDB := -4.0 - 9.0
	if math.Abs(burstMagDB-expectedOutDB) > 0.55 {
		t.Fatalf("compressor steady-state burst output = %0.2f dBFS, want %0.2f dBFS (+/-0.55 dB)", burstMagDB, expectedOutDB)
	}

	// Verify tail after release recovers back to -24 dBFS
	tail := outL[42000:47500]
	tailMagDB := GoertzelMagnitudeDB(tail, sr, 1000.0)
	if math.Abs(tailMagDB-(-24.0)) > 0.4 {
		t.Fatalf("compressor release tail did not recover to -24 dBFS: got %0.2f dBFS", tailMagDB)
	}

	// Verify 90 Hz sidechain HPF prevents 40 Hz sub-bass from pumping a 1 kHz tone
	subMixL := make([]float32, n)
	subMixR := make([]float32, n)
	subAmp := dbToLin(-8.0)    // 40 Hz loud sub-bass above -14 dB threshold
	probeAmp := dbToLin(-22.0) // 1 kHz quiet probe below threshold
	for i := 0; i < n; i++ {
		tm := float64(i) / sr
		v := float32(subAmp*math.Sin(2.0*math.Pi*40.0*tm) + probeAmp*math.Sin(2.0*math.Pi*1000.0*tm))
		subMixL[i] = v
		subMixR[i] = v
	}

	pWithHPF := DefaultParams()
	pWithHPF.Compressor.Enabled = true
	pWithHPF.Compressor.ThresholdDB = -14.0
	pWithHPF.Compressor.Ratio = 8.0
	pWithHPF.Compressor.SidechainHPFHz = 100.0
	outWithHPF, _, _ := RenderBuffer(subMixL, subMixR, sr, pWithHPF)

	pNoHPF := pWithHPF
	pNoHPF.Compressor.SidechainHPFHz = 0.0
	outNoHPF, _, _ := RenderBuffer(subMixL, subMixR, sr, pNoHPF)

	probeWithHPF := GoertzelMagnitudeDB(outWithHPF, sr, 1000.0)
	probeNoHPF := GoertzelMagnitudeDB(outNoHPF, sr, 1000.0)
	if probeWithHPF-probeNoHPF < 2.5 {
		t.Fatalf("expected 90/100 Hz sidechain HPF to protect 1 kHz probe from 40 Hz pumping: withHPF=%0.2f dB, noHPF=%0.2f dB", probeWithHPF, probeNoHPF)
	}
}

func TestSaturationHarmonicProfilesAndDCBlock(t *testing.T) {
	const sr = 48000.0
	inL, inR := generateToneStereo(sr, 1000.0, dbToLin(-6.0), 0.5, 0.0)

	// Warm = asymmetric tube -> H2 (2000 Hz) > H3 (3000 Hz)
	warmP := DefaultParams()
	warmP.Saturation.Enabled = true
	warmP.Saturation.Amount = 75.0
	warmP.Saturation.Character = SatWarm
	warmL, warmR, warmMetrics := RenderBuffer(inL, inR, sr, warmP)
	warmH2 := GoertzelMagnitudeDB(warmL, sr, 2000.0)
	warmH3 := GoertzelMagnitudeDB(warmL, sr, 3000.0)
	if warmH2 <= warmH3+3.0 {
		t.Fatalf("SatWarm expected even-order H2 (%0.2f dB) > H3 (%0.2f dB) + 3 dB", warmH2, warmH3)
	}
	if warmMetrics.DCLeftDBFS > -60.0 || warmMetrics.DCRightDBFS > -60.0 {
		t.Fatalf("SatWarm DC blocker failed: DC left=%0.2f dBFS, right=%0.2f dBFS", warmMetrics.DCLeftDBFS, warmMetrics.DCRightDBFS)
	}
	_ = warmR

	// Thick = symmetric tape -> odd-order H3 (3000 Hz) >> H2 (2000 Hz)
	thickP := DefaultParams()
	thickP.Saturation.Enabled = true
	thickP.Saturation.Amount = 75.0
	thickP.Saturation.Character = SatThick
	thickL, _, _ := RenderBuffer(inL, inR, sr, thickP)
	thickH2 := GoertzelMagnitudeDB(thickL, sr, 2000.0)
	thickH3 := GoertzelMagnitudeDB(thickL, sr, 3000.0)
	if thickH3 <= thickH2+15.0 {
		t.Fatalf("SatThick expected odd-order H3 (%0.2f dB) >> H2 (%0.2f dB)", thickH3, thickH2)
	}
}

func TestStereoWidthAndMonoBassCrossover(t *testing.T) {
	const sr = 48000.0
	const n = 48000
	inL := make([]float32, n)
	inR := make([]float32, n)
	// Centered 40 Hz bass, out-of-phase 80 Hz bass, and 90-degree stereo 4 kHz tone.
	for i := 0; i < n; i++ {
		tm := float64(i) / sr
		bassL := 0.35 * math.Sin(2.0*math.Pi*80.0*tm)
		bassR := -0.35 * math.Sin(2.0*math.Pi*80.0*tm)
		highL := 0.25 * math.Sin(2.0*math.Pi*4000.0*tm)
		highR := 0.25 * math.Cos(2.0*math.Pi*4000.0*tm)
		monoBass := 0.2 * math.Sin(2.0*math.Pi*40.0*tm)
		inL[i] = float32(monoBass + bassL + highL)
		inR[i] = float32(monoBass + bassR + highR)
	}

	// Width = 0% -> mono collapse (correlation >= +0.9999)
	monoP := DefaultParams()
	monoP.Stereo.WidthPct = 0.0
	_, _, monoM := RenderBuffer(inL, inR, sr, monoP)
	if monoM.Correlation < 0.9999 {
		t.Fatalf("WidthPct=0 expected correlation >= 0.9999, got %0.6f", monoM.Correlation)
	}

	// MonoBass = true -> low-bass (<110 Hz) correlation >= +0.985 while 4 kHz Side stays wide
	mbP := DefaultParams()
	mbP.Stereo.WidthPct = 130.0
	mbP.Stereo.MonoBass = true
	mbP.Stereo.CrossoverHz = 110.0
	mbL, mbR, mbM := RenderBuffer(inL, inR, sr, mbP)
	if mbM.LowBassCorrelation < 0.985 {
		t.Fatalf("MonoBass=true expected LowBassCorrelation >= 0.985, got %0.4f", mbM.LowBassCorrelation)
	}
	// Verify 4 kHz Side energy is still present
	side := make([]float32, n)
	for i := 0; i < n; i++ {
		side[i] = 0.5 * (mbL[i] - mbR[i])
	}
	highSideDB := GoertzelMagnitudeDB(side, sr, 4000.0)
	if highSideDB < -20.0 {
		t.Fatalf("MonoBass collapsed 4 kHz stereo side signal: got %0.2f dBFS", highSideDB)
	}
}

func TestSamplePeakLimiterWithoutImplicitLoudnessGain(t *testing.T) {
	const sr = 48000.0
	inL, inR := generateToneStereo(sr, 997, dbToLin(-18), 1, 0.2)
	p := DefaultParams()
	p.Limiter.Enabled = true
	p.Limiter.CeilingDBTP = -1
	p.Limiter.TargetLUFS = -14
	outL, outR, _ := RenderBuffer(inL, inR, sr, p)
	for i := range inL {
		if outL[i] != inL[i] || outR[i] != inR[i] {
			t.Fatal("sub-ceiling input received implicit loudness gain")
		}
	}
	p.Limiter.TargetLUFS = -9
	otherL, otherR, _ := RenderBuffer(inL, inR, sr, p)
	for i := range outL {
		if otherL[i] != outL[i] || otherR[i] != outR[i] {
			t.Fatal("legacy target metadata changed audio")
		}
	}
}

func TestParameterOrthogonalityMatrix(t *testing.T) {
	const sr = 48000.0
	e := NewEngine(sr)
	base := e.Params()

	// Mutating a single band via SetBand must never alter any other band or module parameter
	for b := 0; b < NumEQBands; b++ {
		modified := base.Bands[b]
		modified.GainDB = 4.25
		e.SetBand(b, modified)
		got := e.Params()
		if got.Bands[b].GainDB != 4.25 {
			t.Fatalf("SetBand(%d) did not update target band gain", b)
		}
		for other := 0; other < NumEQBands; other++ {
			if other != b && got.Bands[other] != base.Bands[other] {
				t.Fatalf("SetBand(%d) mutated other band %d: got %+v, want %+v", b, other, got.Bands[other], base.Bands[other])
			}
		}
		if got.Compressor != base.Compressor || got.Saturation != base.Saturation || got.Stereo != base.Stereo || got.Limiter != base.Limiter || got.Repair != base.Repair {
			t.Fatalf("SetBand(%d) mutated unrelated module parameters", b)
		}
		e.SetBand(b, base.Bands[b])
	}

	// Verify that adjusting Stereo.WidthPct on a centered mono signal produces 0.00 dB spectral change
	monoL, monoR := generateToneStereo(sr, 1000.0, 0.4, 0.5, 0.0)
	pWide := DefaultParams()
	pWide.Stereo.WidthPct = 180.0
	outWideL, _, _ := RenderBuffer(monoL, monoR, sr, pWide)
	baseMag := GoertzelMagnitudeDB(monoL, sr, 1000.0)
	wideMag := GoertzelMagnitudeDB(outWideL, sr, 1000.0)
	if math.Abs(wideMag-baseMag) > 1e-4 {
		t.Fatalf("Stereo.WidthPct altered mono signal magnitude by %0.6f dB", wideMag-baseMag)
	}
}
