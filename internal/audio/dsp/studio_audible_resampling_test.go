package dsp

import (
	"fmt"
	"math"
	"testing"
)

func mustStudioAudible(t testing.TB, rate float64, factor int) *studioAudibleKernel {
	t.Helper()
	c, err := prepareStudioAudibleKernel(rate, factor)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestStudioAudibleActualImpulsePassbandStopAndLatency(t *testing.T) {
	const count = 65536
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, factor := range []int{2, 4} {
			c := mustStudioAudible(t, rate, factor)
			up, down := studioAudibleUpsampler{}, studioAudibleDownsampler{}
			impulse := make([]float64, 2*c.pairLatency+1)
			largest, maximum, sum := 0, 0.0, 0.0
			for frame := range impulse {
				x := 0.0
				if frame == 0 {
					x = 1
				}
				impulse[frame], _ = down.process(c, up.process(c, x, 0))
				sum += impulse[frame]
				if math.Abs(impulse[frame]) > maximum {
					largest, maximum = frame, math.Abs(impulse[frame])
				}
			}
			if largest != c.pairLatency || math.Abs(sum-1) > 1e-11 {
				t.Fatalf("rate%g factor%d measured delay%d declared%d DCsum%.17g", rate, factor, largest, c.pairLatency, sum)
			}
			bins := make([]complex128, count)
			for i, value := range impulse {
				bins[i] = complex(value, 0)
				if math.Abs(value-impulse[len(impulse)-1-i]) > 1e-12 {
					t.Fatal("actual combined impulse is not symmetric")
				}
			}
			studioTestFFT(bins, false)
			minimum, maxDB, maxPhase := 1000.0, -1000.0, 0.0
			for bin, value := range bins[:count/2+1] {
				frequency := float64(bin) * rate / count
				if frequency > c.passHz {
					break
				}
				db := 20 * math.Log10(math.Hypot(real(value), imag(value)))
				angle := 2 * math.Pi * float64(bin*c.pairLatency) / count
				rotated := value * complex(math.Cos(angle), math.Sin(angle))
				phase := math.Abs(math.Atan2(imag(rotated), real(rotated)) * 180 / math.Pi)
				minimum, maxDB, maxPhase = math.Min(minimum, db), math.Max(maxDB, db), math.Max(maxPhase, phase)
				if math.Abs(db) > .1 || phase > .001 {
					t.Fatalf("rate%g factor%d frequency%g pass%g dB phase%gdegrees", rate, factor, frequency, db, phase)
				}
			}
			// Recover the ACTUAL high-rate decimator response by injecting each
			// phase separately; do not report only the prepared coefficient array.
			clear(bins)
			for phase := 0; phase < factor; phase++ {
				down = studioAudibleDownsampler{}
				for frame := 0; frame <= (c.taps+factor-1)/factor; frame++ {
					var high [4][2]float64
					if frame == 0 {
						high[phase][0] = 1
					}
					x, _ := down.process(c, high)
					index := factor*frame - phase
					if index >= 0 && index < c.taps {
						bins[index] = complex(x, 0)
					}
				}
			}
			studioTestFFT(bins, false)
			stop := 0.0
			for bin, value := range bins[:count/2+1] {
				frequency := float64(bin*factor) * rate / count
				if frequency >= c.stopHz {
					stop = math.Max(stop, math.Hypot(real(value), imag(value)))
				}
			}
			stopDB := 20 * math.Log10(stop)
			t.Logf("rate%.0f factor%d taps%d passHz%g pairdelay%d pass%.9f..%.9fdB phase%.9fdeg stop%.9fdB", rate, factor, c.taps, c.passHz, largest, minimum, maxDB, maxPhase, stopDB)
			if stopDB > -90 {
				t.Fatal("actual decimator did not meet candidate 90 dB stop target")
			}
		}
	}
}

func TestStudioAudibleIndependentConvolutionAndNonIdentityPhaseZero(t *testing.T) {
	for _, factor := range []int{2, 4} {
		c := mustStudioAudible(t, 48000, factor)
		const frames = 129
		source := make([]float64, frames)
		for i := range source {
			source[i] = .7*math.Sin(float64(i)*.173) + .1*math.Cos(float64(i)*.31)
		}
		count := frames + 2*c.pairLatency
		// Independent zero insertion + direct full high-rate convolution twice.
		interpolated := make([]float64, count*factor+c.taps)
		for i, x := range source {
			for tap := 0; tap < c.taps; tap++ {
				interpolated[i*factor+tap] += x * float64(factor) * c.full[tap]
			}
		}
		up, down := studioAudibleUpsampler{}, studioAudibleDownsampler{}
		for frame := 0; frame < count; frame++ {
			x := 0.0
			if frame < len(source) {
				x = source[frame]
			}
			got, _ := down.process(c, up.process(c, x, 0))
			want := 0.0
			for tap := 0; tap < c.taps; tap++ {
				index := frame*factor - tap
				if index >= 0 {
					want += c.full[tap] * interpolated[index]
				}
			}
			if math.Abs(got-want) > 3e-14 {
				t.Fatalf("factor%d frame%d streaming%.17g direct%.17g", factor, frame, got, want)
			}
		}
		center := c.center / factor
		if math.Abs(c.phases[0][center]-1) < .001 {
			t.Fatal("candidate retained the old phase-zero raw identity shortcut")
		}
	}
}

func TestStudioAudibleDCInvalidAndNoCallbackAllocations(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, factor := range []int{2, 4} {
			c := mustStudioAudible(t, rate, factor)
			up, down := studioAudibleUpsampler{}, studioAudibleDownsampler{}
			var l, r float64
			for range 2*c.pairLatency + 32 {
				l, r = down.process(c, up.process(c, .2, -.1))
			}
			if math.Abs(l-.2) > 1e-12 || math.Abs(r+.1) > 1e-12 {
				t.Fatal("candidate failed settled DC gain")
			}
			for _, invalid := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
				l, r = down.process(c, up.process(c, invalid, -invalid))
				if !finite(l) || !finite(r) {
					t.Fatal("candidate emitted nonfinite samples")
				}
			}
			if allocations := testing.AllocsPerRun(3, func() {
				for range 128 {
					down.process(c, up.process(c, .2, -.1))
				}
			}); allocations != 0 {
				t.Fatal("candidate callback allocated")
			}
		}
	}
}

var studioAudibleBenchmarkSink float64

func BenchmarkStudioAudibleFIRBlock(b *testing.B) {
	for _, rate := range []float64{48000, 96000, 192000} {
		for _, factor := range []int{2, 4} {
			b.Run(fmt.Sprintf("rate%.0f/factor%d", rate, factor), func(b *testing.B) {
				c := mustStudioAudible(b, rate, factor)
				up, down := studioAudibleUpsampler{}, studioAudibleDownsampler{}
				var input [128][2]float64
				for i := range input {
					input[i] = [2]float64{.8 * math.Sin(float64(i)*.173), .7 * math.Cos(float64(i)*.217)}
				}
				process := func() {
					for _, pair := range input {
						l, r := down.process(c, up.process(c, pair[0], pair[1]))
						studioAudibleBenchmarkSink = l + r
					}
				}
				for range 64 {
					process()
				}
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					process()
				}
			})
		}
	}
}
