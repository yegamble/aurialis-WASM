package truepeakref

import (
	"fmt"
	"math"
	"testing"
)

// fade tapers both ends with a raised cosine so the finite signal does not
// ring: a hard-cut tone near Nyquist rings for thousands of samples.
func fade(x []float32, frames int) {
	for i := 0; i < frames; i++ {
		g := float32(0.5 - 0.5*math.Cos(math.Pi*float64(i)/float64(frames)))
		x[i] *= g
		x[len(x)-1-i] *= g
	}
}

// A sine's true peak is its amplitude, whatever its phase against the sample
// grid. Tones up to 0.498 fs, where short kernels under-read by decibels, must
// read within the 32x grid error.
func TestPeakDBTPReadsSinesExactlyToNearNyquist(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000} {
		for _, ratio := range []float64{0.02, 0.3, 0.45, 0.479, 0.49, 0.498} {
			t.Run(fmt.Sprintf("%.0f/%.3ffs", rate, ratio), func(t *testing.T) {
				const amplitude = 0.5
				n := int(rate / 2)
				left, right := make([]float32, n), make([]float32, n)
				for i := range left {
					angle := 2 * math.Pi * ratio * float64(i)
					left[i] = float32(amplitude * math.Sin(angle+0.37))
					right[i] = float32(0.5 * amplitude * math.Cos(angle+1.91))
				}
				fade(left, 4096)
				fade(right, 4096)
				got := PeakDBTP([][]float32{left, right}, 4096)
				want := 20 * math.Log10(amplitude)
				// The cos(pi/64) grid error and the fades' slight spread bound the reading.
				if got > want+0.002 || got < want-0.006 {
					t.Fatalf("%.3f fs sine read %.4f dBTP, want %.4f", ratio, got, want)
				}
			})
		}
	}
}

// The spectral reconstruction agrees with a direct +-1024-tap Kaiser-windowed
// sinc, the kernel QA validated, on dense content band-limited to 0.47 fs.
func TestPeakDBTPMatchesLongDirectSinc(t *testing.T) {
	const n, half, beta = 1 << 13, 1024, 12.0
	x := make([]float32, n)
	state := uint32(7)
	random := func() float64 {
		state = state*1664525 + 1013904223
		return float64(state) / math.MaxUint32
	}
	for tone := 0; tone < 48; tone++ {
		frequency, phase := 0.47*random(), 2*math.Pi*random()
		for i := range x {
			x[i] += float32(0.03 * math.Sin(2*math.Pi*frequency*float64(i)+phase))
		}
	}
	fade(x, 1024)
	ref := PeakDBTP([][]float32{x}, 2048)
	bessel := func(v float64) float64 {
		sum, term := 1.0, 1.0
		for k := 1; k < 60; k++ {
			term *= v / 2 / float64(k)
			sum += term * term
		}
		return sum
	}
	var kernel [Phases][2 * half]float64
	for p := range kernel {
		for k := range kernel[p] {
			d := float64(k-half+1) - float64(p)/Phases
			w := d / half
			sinc := 1.0
			if d != 0 {
				sinc = math.Sin(math.Pi*d) / (math.Pi * d)
			}
			kernel[p][k] = sinc * bessel(beta*math.Sqrt(math.Max(0, 1-w*w))) / bessel(beta)
		}
	}
	direct := 0.0
	for i := 2048; i < n-2048; i++ {
		for p := range kernel {
			v := 0.0
			for k, c := range kernel[p] {
				v += c * float64(x[i+k-half+1])
			}
			direct = math.Max(direct, math.Abs(v))
		}
	}
	if diff := math.Abs(20*math.Log10(direct) - ref); diff > 0.01 {
		t.Fatalf("direct sinc %.4f dBTP vs spectral %.4f dBTP", 20*math.Log10(direct), ref)
	}
}

// The direct kernel reads a lone sample and a crest-start tone exactly, and
// agrees with PeakDBTP away from the edges.
func TestDirectPeakDBTPEdges(t *testing.T) {
	x := make([]float32, 64)
	x[0] = 0.9
	if got, want := DirectPeakDBTP([][]float32{x}), 20*math.Log10(0.9); math.Abs(got-want) > 0.001 {
		t.Fatalf("lone sample read %.4f dBTP, want %.4f", got, want)
	}
	tone := make([]float32, 4096)
	for i := range tone {
		tone[i] = float32(0.5 * math.Sin(2*math.Pi*0.3*float64(i)+0.4))
	}
	fade(tone, 1024)
	if a, b := DirectPeakDBTP([][]float32{tone}), PeakDBTP([][]float32{tone}, 0); math.Abs(a-b) > 0.01 {
		t.Fatalf("direct %.4f dBTP vs spectral %.4f dBTP", a, b)
	}
}
