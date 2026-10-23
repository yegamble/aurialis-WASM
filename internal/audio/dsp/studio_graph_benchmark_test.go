package dsp

import (
	"fmt"
	"testing"
)

// Each stage receives captured output from the preceding stages of the same
// warmed all-active graph. Timings isolate arithmetic; the complete-graph
// benchmark remains the callback-budget gate, including layout/delay overhead.
func BenchmarkStudioGraphStageCosts(b *testing.B) {
	for _, rate := range []float64{48000, 192000} {
		b.Run(fmt.Sprintf("rate%.0f", rate), func(b *testing.B) {
			for _, name := range []string{"prefix", "compressor", "saturation", "stereo", "filters4x", "gain4x", "postDetector", "postDetectorRing", "postGuard", "quantize24"} {
				b.Run(name, func(b *testing.B) {
					p := studioGraphActiveParams()
					p.Compressor.MakeupDB, p.DitherBits = 12, 24
					g := mustStudioGraph(b, rate, p, 128, true)
					left, right := studioGraphSignal(128)
					for i := range left {
						left[i] *= 4
						right[i] *= 4
					}
					var outL, outR [128]float32
					for range 64 {
						g.processBlock(left, right, outL[:], outR[:])
					}
					var input [128][2]float64
					var high [128][4][2]float64
					var ring studioPostGuardDetectorReference
					for i := range input {
						l, r := float64(left[i]), float64(right[i])
						save := func(stage string) {
							if stage == name {
								input[i] = [2]float64{l, r}
							}
						}
						save("prefix")
						l, r = g.processPrefix(l, r)
						save("compressor")
						l, r = g.compressor.process(l, r)
						save("saturation")
						l, r = g.saturation.process(l, r)
						save("stereo")
						l, r = g.stereo.process(l, r)
						save("filters4x")
						subs := g.up.process(&g.kernel, l, r)
						high[i] = subs
						for phase, pair := range subs {
							a, c, _, _ := g.gain.process(pair[0], pair[1])
							subs[phase] = [2]float64{a, c}
						}
						l, r = g.down.process(&g.kernel, subs)
						save("postDetector")
						save("postDetectorRing")
						save("postGuard")
						l, r = g.guard.process(l, r)
						save("quantize24")
					}
					process := func() {
						for i, pair := range input {
							l, r := pair[0], pair[1]
							switch name {
							case "prefix":
								l, r = g.processPrefix(l, r)
							case "compressor":
								l, r = g.compressor.process(l, r)
							case "saturation":
								l, r = g.saturation.process(l, r)
							case "stereo":
								l, r = g.stereo.process(l, r)
							case "filters4x":
								l, r = g.down.process(&g.kernel, g.up.process(&g.kernel, l, r))
							case "gain4x":
								for _, sub := range high[i] {
									l, r, _, _ = g.gain.process(sub[0], sub[1])
								}
							case "postDetector":
								_, l = g.guard.detector.process(&g.guard.kernel, l, r)
							case "postDetectorRing":
								_, l = ring.process(&g.guard.kernel, l, r)
							case "postGuard":
								l, r = g.guard.process(l, r)
							case "quantize24":
								l, r = g.front.applyTPDFDither(l, 24), g.front.applyTPDFDither(r, 24)
							}
							studioGraphBenchmarkSink = float32(l + r)
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
					b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*128), "ns/frame")
				})
			}
		})
	}
}
