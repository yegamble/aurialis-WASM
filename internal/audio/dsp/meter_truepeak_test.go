package dsp

import (
	"fmt"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/truepeakref"
)

// V1-13: the true-peak meter behind export reports, Release Check and the live
// meter reads high-frequency sines at any phase within 0.1 dB of the long-sinc
// reference. The ratios have short exact periods, so a tone's peaks keep the
// same offsets from the 4x grid instead of sweeping across it. The 49-tap
// BS.1770-4 Annex 2 filter the meter replaced read these up to 0.44 dB low.
func TestTruePeakMeterReadsHighFrequencySinesWithinATenthOfADecibel(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, ratio := range []float64{0.05, 0.25, 0.375, 0.4, 0.4375, 0.45} {
			t.Run(fmt.Sprintf("%.0f/%.2ffs", rate, ratio), func(t *testing.T) {
				t.Parallel()
				worst, highest := 0.0, math.Inf(-1)
				for _, phase := range []float64{0, 0.4, 0.8, 1.3, 1.9, 2.6} {
					const n, taper = 6000, 1500
					left, right := make([]float32, n), make([]float32, n)
					for i := range left {
						fade := math.Min(1, 0.5-0.5*math.Cos(math.Pi*math.Min(float64(i), float64(n-1-i))/taper))
						left[i] = float32(0.5 * fade * math.Sin(2*math.Pi*ratio*float64(i)+phase))
						right[i] = float32(0.25 * fade * math.Sin(2*math.Pi*ratio*float64(i)+2*phase))
					}
					reference := truepeakref.PeakDBTP([][]float32{left, right}, 0)
					export := MeasureStereo(left, right, rate).TruePeakDBTP
					live := NewLoudnessMeter(rate)
					live.Process(left, right)
					for _, reading := range []float64{export, live.Snapshot().TruePeakDBTP} {
						worst = math.Min(worst, reading-reference)
						highest = math.Max(highest, reading-reference)
					}
				}
				if worst < -0.1 || highest > 0.02 {
					t.Fatalf("meter error %+.3f…%+.3f dB against the reference", worst, highest)
				}
			})
		}
	}
}
