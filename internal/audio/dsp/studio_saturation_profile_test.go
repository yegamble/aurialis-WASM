package dsp

// cspell:words oversampler

import (
	"fmt"
	"math"
	"testing"
)

type studioSaturationProfileInput struct {
	base, wet    [128][2]float64
	high, shaped [128][2][studioOversampling]float64
}

// Capture an actual hot prepared prefix/compressor block, then independently
// advance a copy of the original saturation stages to freeze each stage input.
// These diagnostic stages are not additive timing or a new audio algorithm.
func prepareStudioSaturationProfile(b *testing.B, rate float64, kind string) (studioSaturation, studioSaturationProfileInput) {
	b.Helper()
	params := studioAudibleGraphActiveParams()
	params.Compressor.MakeupDB, params.DitherBits = 12, 24
	graph := mustStudioPartitionedAudibleGraph(b, rate, params, 128, true)
	left, right := studioGraphSignal(128)
	for i := range left {
		left[i], right[i] = 4*left[i], 4*right[i]
		if kind == "peaky" {
			time := float64(i) / rate
			high := .97 * math.Min(20000, .49*rate)
			value := 1.1*math.Sin(2*math.Pi*high*time+.2) + .9*math.Sin(2*math.Pi*high*.731*time+.6)
			left[i], right[i] = float32(value), float32(-.7*value)
		}
	}
	var outLeft, outRight [128]float32
	for range 64 {
		graph.processBlock(left, right, outLeft[:], outRight[:])
	}
	original, probe := graph.saturation, graph.saturation
	var input studioSaturationProfileInput
	for frame := range input.base {
		l, r := graph.processPrefix(float64(left[frame]), float64(right[frame]))
		l, r = graph.compressor.process(l, r)
		input.base[frame] = [2]float64{l, r}
		for channel, value := range input.base[frame] {
			high := probe.oversampler[channel].interpolate(&probe.filter, value)
			input.high[frame][channel] = high
			for phase, sample := range high {
				shaped := probe.tube[channel].process(sample, probe.curve)
				input.shaped[frame][channel][phase] = shaped
				high[phase] = probe.pad[channel].process(shaped)
			}
			input.wet[frame][channel] = probe.oversampler[channel].decimate(&probe.filter, high)
		}
	}
	return original, input
}

func studioSaturationProfileMix(s *studioSaturation, input, wet [2]float64) float64 {
	s.mix, s.dcMix = s.targets()
	result := 0.0
	for channel, value := range input {
		dry := s.dry[channel][s.dryCursor]
		s.dry[channel][s.dryCursor] = value
		mixed := (1-s.mix)*dry + s.mix*wet[channel]
		dc := sanitizeSample(mixed - s.dcInput[channel] + s.dcPole*s.dcOutput[channel])
		s.dcInput[channel], s.dcOutput[channel] = mixed, dc
		result += sanitizeSample((1-s.dcMix)*mixed + s.dcMix*dc)
	}
	s.dryCursor = (s.dryCursor + 1) % studioSaturationLatency
	return result
}

func BenchmarkStudioSaturationCurrentSplitCosts(b *testing.B) {
	for _, rate := range []float64{48000, 192000} {
		for _, kind := range []string{"steady", "peaky"} {
			for _, stage := range []string{"full", "filters4x", "adaa", "pad", "dryMixDC"} {
				b.Run(fmt.Sprintf("rate%.0f/%s/%s", rate, kind, stage), func(b *testing.B) {
					s, input := prepareStudioSaturationProfile(b, rate, kind)
					process := func() {
						for frame, pair := range input.base {
							value := 0.0
							switch stage {
							case "full":
								left, right := s.process(pair[0], pair[1])
								value = left + right
							case "filters4x":
								for channel, sample := range pair {
									value += s.oversampler[channel].decimate(&s.filter, s.oversampler[channel].interpolate(&s.filter, sample))
								}
							case "adaa":
								for channel, samples := range input.high[frame] {
									for _, sample := range samples {
										value += s.tube[channel].process(sample, s.curve)
									}
								}
							case "pad":
								for channel, samples := range input.shaped[frame] {
									for _, sample := range samples {
										value += s.pad[channel].process(sample)
									}
								}
							case "dryMixDC":
								value = studioSaturationProfileMix(&s, pair, input.wet[frame])
							}
							studioGraphBenchmarkSink = float32(value)
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
}
