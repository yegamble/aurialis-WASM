package dsp

import (
	"math"
	"testing"
)

func saturate(p Params, freq, amp float64) ([]float32, []float32) {
	const rate = 48000
	e := NewEngine(rate)
	e.SetParams(p)
	in := make([]float32, 2*rate)
	for i := range in {
		in[i] = float32(amp * math.Sin(2*math.Pi*freq*float64(i)/rate))
	}
	outL, outR := make([]float32, len(in)), make([]float32, len(in))
	e.ProcessBlock(in, in, outL, outR)
	return in[rate:], outL[rate:]
}

func levelChangeDB(in, out []float32) float64 {
	var a, b float64
	for i := range in {
		a += float64(in[i]) * float64(in[i])
		b += float64(out[i]) * float64(out[i])
	}
	return 10 * math.Log10(b/a)
}

// Audit finding 4: saturation dulled 16-20 kHz by 2-9 dB and Thick/Crisp added
// 5-15 dB at low levels. Low-level response must now be flat to 20 kHz, near
// unity, while drive still adds harmonics and the worst alias stays lower.
func TestSaturationIsFlatNearUnityAndStillSaturates(t *testing.T) {
	for _, character := range []SatCharacter{SatWarm, SatThick, SatCrisp, SatTube, SatTape, SatTransformer} {
		for _, amount := range []float64{10, 50, 100} {
			p := DefaultParams()
			p.Saturation = SaturationParams{Enabled: true, Amount: amount, Character: character}
			ref := levelChangeDB(saturate(p, 1000, 0.01))
			// Crisp and Tape keep a deliberate broadband tilt; others are unity.
			if limit := 0.1 + 0.025*amount*boolToFloat(character == SatCrisp || character == SatTape); math.Abs(ref) > limit {
				t.Errorf("%s %.0f%%: low-level gain %+.2f dB, want within ±%.2f", character, amount, ref, limit)
			}
			// Crisp's intended presence sheen rises about 0.27 dB above 1 kHz at 100%.
			flat := 0.1 + 0.002*amount*boolToFloat(character == SatCrisp)
			for _, f := range []float64{10000, 16000, 20000} {
				if got := levelChangeDB(saturate(p, f, 0.01)) - ref; math.Abs(got) > flat {
					t.Errorf("%s %.0f%%: %g Hz is %+.2f dB relative to 1 kHz, want flat ±%.2f", character, amount, f, got, flat)
				}
			}
			if character == SatTransformer || amount < 50 {
				continue
			}
			_, out := saturate(p, 1000, 0.5)
			fundamental := GoertzelMagnitudeDB(out, 48000, 1000)
			var harmonics float64
			for k := 2.0; k <= 9; k++ {
				harmonics += math.Pow(10, GoertzelMagnitudeDB(out, 48000, 1000*k)/10)
			}
			if thd := 10*math.Log10(harmonics) - fundamental; thd < -35 {
				t.Errorf("%s %.0f%%: THD at -6 dBFS %.1f dB, drive no longer saturates", character, amount, thd)
			}
			_, hot := saturate(p, 15000, 0.7)
			if alias := GoertzelMagnitudeDB(hot, 48000, 3000) - GoertzelMagnitudeDB(hot, 48000, 15000); alias > -30 {
				t.Errorf("%s %.0f%%: 15 kHz third-harmonic alias at 3 kHz %.1f dBc, want below -30", character, amount, alias)
			}
		}
	}
}

func boolToFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
