package dsp

import (
	"fmt"
	"math"
	"math/big"
	"testing"
)

func TestStudioPartitionedPostDetectorMatchesFrozenPeakAndClock(t *testing.T) {
	kernel := prepareStudioPartitionedPostGuardKernel()
	frozen := prepareStudioPostGuardKernel()
	for _, magnitude := range []float64{1, 1e6} {
		var current studioPartitionedPostGuardDetector
		var original studioPostGuardDetectorReference
		var expected [studioPostPartitionFrames]float64
		maximum := 0.0
		for i := range 8192 {
			left := .8*math.Sin(2*math.Pi*.49*float64(i)+.37) + .31*math.Cos(2*math.Pi*.123*float64(i))
			right := -.7*left + .25*math.Sin(2*math.Pi*.371*float64(i))
			if i%997 == 0 {
				left += 1.3
				right -= .9
			}
			if i > 6000 {
				left, right = 0, 0
			}
			left, right = left*magnitude, right*magnitude
			_, direct := original.process(&frozen, left, right)
			want := 0.0
			if i >= studioPostPartitionDelay {
				want = expected[(i-studioPostPartitionDelay)&(studioPostPartitionFrames-1)]
			}
			expected[i&(studioPostPartitionFrames-1)] = direct
			index, got := current.process(kernel, left, right)
			if index != int64(i-studioPostGuardAvailability-studioPostPartitionDelay) {
				t.Fatal("partitioning shifted the source-frame peak timestamp")
			}
			if i >= studioPostPartitionDelay {
				errorValue := math.Abs(got - want)
				maximum = math.Max(maximum, errorValue)
				if errorValue > 1e-10*magnitude {
					t.Fatalf("frame%d peak%.17g want%.17g error%.9g", i, got, want, errorValue)
				}
			}
		}
		t.Logf("magnitude%g maximum delayed peak error%.9g", magnitude, maximum)
	}
}

func TestStudioPartitionedPostDetectorFFTAndStereoLeakage(t *testing.T) {
	kernel := prepareStudioPartitionedPostGuardKernel()
	var values, original [studioPostPartitionFFT]complex128
	for i := range values {
		values[i] = complex(math.Sin(.73*float64(i)), .3*math.Cos(.311*float64(i)))
	}
	original = values
	kernel.transform(&values, false)
	kernel.transform(&values, true)
	for i := range values {
		if math.Hypot(real(values[i]-original[i]), imag(values[i]-original[i])) > 2e-14 {
			t.Fatal("FFT round trip exceeded fixed numerical tolerance")
		}
	}
	var detector studioPartitionedPostGuardDetector
	for i := range 2048 {
		detector.process(kernel, math.Sin(.173*float64(i)), 0)
		if i%studioPostPartitionFrames == studioPostPartitionFrames-1 {
			for phase := range detector.output {
				for _, value := range detector.output[phase][studioPostPartitionFrames:] {
					if math.Abs(imag(value)) > 2e-14 {
						t.Fatal("complex packing leaked nonzero left audio into the zero right channel")
					}
				}
			}
		}
	}
	var prepared [128]float64
	for i := range prepared {
		prepared[i] = .8 * math.Sin(float64(i))
	}
	if allocations := testing.AllocsPerRun(2, func() {
		for _, value := range prepared {
			detector.process(kernel, value, -.2)
		}
	}); allocations != 0 {
		t.Fatal("partitioned detector callback allocated")
	}
}

func BenchmarkStudioPartitionedPostDetectorBlock(b *testing.B) {
	// Alternate the order of each pair in one compiled binary. A single target
	// run reports both old and new kernels on the same host/input, not a claimed
	// native/WASM speedup or full graph browser deadline result.
	for trial := range 4 {
		order := [2]bool{false, true}
		if trial&1 != 0 {
			order = [2]bool{true, false}
		}
		for _, partitioned := range order {
			name := "direct"
			if partitioned {
				name = "partitioned"
			}
			b.Run(fmt.Sprintf("pair%d/%s", trial, name), func(b *testing.B) {
				kernel, frozen := prepareStudioPartitionedPostGuardKernel(), prepareStudioPostGuardKernel()
				var current studioPartitionedPostGuardDetector
				var old studioPostGuardDetector
				var input [128][2]float64
				for i := range input {
					input[i] = [2]float64{.8*math.Sin(.173*float64(i)) + .3*math.Cos(.491*float64(i)), .5 * math.Sin(.731*float64(i))}
				}
				process := func() {
					for _, pair := range input {
						peak := 0.0
						if partitioned {
							_, peak = current.process(kernel, pair[0], pair[1])
						} else {
							_, peak = old.process(&frozen, pair[0], pair[1])
						}
						studioAudibleBenchmarkSink = peak
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
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/1e6, "ms/128")
			})
		}
	}
}

// This independent unpaired time-domain convolution uses immutable source
// coordinates and zero exterior, rather than the production ring/FFT indices.
func TestStudioPartitionedPostDetectorDirectConvolutionAndFiniteEdges(t *testing.T) {
	k, frozen := prepareStudioPartitionedPostGuardKernel(), prepareStudioPostGuardKernel()
	for _, count := range []int{1, 127, 128, 129, 257, 513, 4097} {
		t.Run(fmt.Sprintf("frames%d", count), func(t *testing.T) {
			source := make([]complex128, count)
			state := uint32(0x37f81b29)
			magnitude := 0.0
			for i := range source {
				state ^= state << 13
				state ^= state >> 17
				state ^= state << 5
				value := 2*float64(state)/float64(math.MaxUint32) - 1
				source[i] = complex(value, .1*math.Sin(.731*float64(i)))
				if i == 0 {
					source[i] += complex(1.5, -.8)
				}
				if i == count-1 {
					source[i] += complex(-1.3, .9)
				}
				magnitude = math.Max(magnitude, math.Hypot(real(source[i]), imag(source[i])))
			}
			var d studioPartitionedPostGuardDetector
			maximum := 0.0
			steps := (count + 1024 + 2*studioPostPartitionFrames - 1) / studioPostPartitionFrames * studioPostPartitionFrames
			bound := studioPartitionedFIRRoundingAllowance(&frozen, magnitude)
			for frame := 0; frame < steps; frame++ {
				value := complex(0, 0)
				if frame < count {
					value = source[frame]
				}
				d.process(k, real(value), imag(value))
				if frame%studioPostPartitionFrames != studioPostPartitionFrames-1 {
					continue
				}
				for phase := range d.output {
					for i := range studioPostPartitionFrames {
						want := complex(0, 0)
						sourceFrame := frame - studioPostPartitionFrames + 1 + i
						for tap := range 1024 {
							index := sourceFrame - tap
							if index < 0 || index >= count {
								continue
							}
							coefficient := 0.0
							switch phase {
							case 0:
								coefficient = frozen.quarter[tap]
							case 1:
								coefficient = frozen.half[min(tap, 1023-tap)]
							case 2:
								coefficient = frozen.quarter[1023-tap]
							}
							want += source[index] * complex(coefficient, 0)
						}
						delta := d.output[phase][studioPostPartitionFrames+i] - want
						errorValue := math.Hypot(real(delta), imag(delta))
						maximum = math.Max(maximum, errorValue)
						if errorValue > bound {
							t.Fatalf("frame%d phase%d FIR error%.9g exceeds conservative arithmetic allowance%.9g", sourceFrame, phase, errorValue, bound)
						}
					}
				}
			}
			t.Logf("seed0x37f81b29 max complex FIR error%.9g arithmetic allowance%.9g", maximum, bound)
		})
	}
}

// An arithmetic allowance for the FIR ONLY under finite IEEE binary64 normal
// round-to-nearest operations. Root component error <=2e-15 is independently
// checked against320-bit Taylor values below. Eight stages charge64 rounding steps
// each; the8 factor covers forward-input/kernel transforms, complex products,
// eight-way accumulation, inverse transform and packing. This does not bound
// the branch-dependent Newton peak search or any ideal-sinc reconstruction.
func studioPartitionedFIRRoundingAllowance(k *studioPostGuardKernel, maxInputMagnitude float64) float64 {
	const unit = 0x1p-53
	gamma := func(n float64) float64 { return n * unit / (1 - n*unit) }
	transform := gamma(64*8) + 8*4e-15
	norm := 0.0
	for _, value := range k.quarter {
		norm += math.Abs(value)
	}
	half := 0.0
	for _, value := range k.half {
		half += 2 * math.Abs(value)
	}
	norm = math.Max(norm, half)
	return 8*studioPostPartitionFFT*(transform+gamma(8*studioPostPartitions))*norm*maxInputMagnitude + 65536*math.SmallestNonzeroFloat64
}

func TestStudioPartitionedPostDetectorPreparedRoots(t *testing.T) {
	k := prepareStudioPartitionedPostGuardKernel()
	pi, _, err := big.ParseFloat("3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679", 10, 320, big.ToNearestEven)
	if err != nil {
		t.Fatal(err)
	}
	maximum := 0.0
	for i, root := range k.twiddles {
		x := new(big.Float).SetPrec(320).Mul(pi, new(big.Float).SetPrec(320).SetInt64(int64(-2*i)))
		x.Quo(x, new(big.Float).SetPrec(320).SetInt64(studioPostPartitionFFT))
		square := new(big.Float).SetPrec(320).Mul(x, x)
		sine, cosine := new(big.Float).SetPrec(320).Set(x), new(big.Float).SetPrec(320).SetInt64(1)
		sinTerm, cosTerm := new(big.Float).SetPrec(320).Set(x), new(big.Float).SetPrec(320).SetInt64(1)
		// |x|<pi;96 Taylor terms leave <1e-250 truncation, far below
		// 320-bit arithmetic precision and the tested binary64 allowance.
		for n := int64(1); n <= 96; n++ {
			sinTerm.Mul(sinTerm, square)
			sinTerm.Neg(sinTerm)
			sinTerm.Quo(sinTerm, new(big.Float).SetPrec(320).SetInt64((2*n)*(2*n+1)))
			sine.Add(sine, sinTerm)
			cosTerm.Mul(cosTerm, square)
			cosTerm.Neg(cosTerm)
			cosTerm.Quo(cosTerm, new(big.Float).SetPrec(320).SetInt64((2*n-1)*(2*n)))
			cosine.Add(cosine, cosTerm)
		}
		for _, pair := range [][2]*big.Float{{new(big.Float).SetPrec(320).SetFloat64(real(root)), cosine}, {new(big.Float).SetPrec(320).SetFloat64(imag(root)), sine}} {
			difference, _ := new(big.Float).SetPrec(320).Sub(pair[0], pair[1]).Float64()
			maximum = math.Max(maximum, math.Abs(difference))
		}
	}
	if maximum > 2e-15 {
		t.Fatalf("prepared root component error%.9g exceeds explicit allowance", maximum)
	}
	t.Logf("independent320-bit prepared-root component error%.9g", maximum)
}

func TestStudioPartitionedPostDetectorPartitionResetAndPartialEOF(t *testing.T) {
	k := prepareStudioPartitionedPostGuardKernel()
	source := make([][2]float64, 129+1024+2*studioPostPartitionFrames)
	for i := 0; i < 129; i++ {
		source[i] = [2]float64{.8 * math.Sin(.173*float64(i)), -.4 * math.Cos(.731*float64(i))}
	}
	source[128] = [2]float64{1.8, -1.3}
	for _, partition := range []int{1, 127, 128, 129, 513} {
		var reference, current studioPartitionedPostGuardDetector
		expected := make([]float64, len(source))
		for i, pair := range source {
			_, expected[i] = reference.process(k, pair[0], pair[1])
		}
		for start := 0; start < len(source); start += partition {
			for i := start; i < min(start+partition, len(source)); i++ {
				frame, peak := current.process(k, source[i][0], source[i][1])
				if frame != int64(i-studioPostGuardAvailability-studioPostPartitionDelay) || math.Float64bits(peak) != math.Float64bits(expected[i]) {
					t.Fatal("external block partition changed peak bytes or timestamp")
				}
			}
		}
		current = studioPartitionedPostGuardDetector{}
		for i, pair := range source {
			_, peak := current.process(k, pair[0], pair[1])
			if math.Float64bits(peak) != math.Float64bits(expected[i]) {
				t.Fatal("reset retained retired partition history")
			}
		}
		lastPeak := 0.0
		for i := studioPostPartitionDelay + 128; i <= studioPostPartitionDelay+128+1024; i++ {
			lastPeak = math.Max(lastPeak, expected[min(i, len(expected)-1)])
		}
		if lastPeak < 1.8 {
			t.Fatal("partial-block last source sample disappeared before convolution/drain completed")
		}
	}
}
