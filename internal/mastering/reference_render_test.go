package mastering

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestReferenceStreamingBassMatchesFullReconstructedRender(t *testing.T) {
	for _, rate := range []int{8000, 44100, 48000, 96000, 192000} {
		for _, seconds := range []float64{1.0 / float64(rate), .127, 1.003} {
			source := featureSignal(rate, seconds, func(i int) (float32, float32) {
				v := float32(.07 + .04*math.Sin(2*math.Pi*60*float64(i)/float64(rate)) + .01*math.Sin(2*math.Pi*2700*float64(i)/float64(rate)))
				return v, v * .8
			})
			params := dsp.DefaultParams()
			params.Compressor.Enabled = true
			params.Compressor.ThresholdDB = -24
			params.Compressor.Ratio = 3
			params.Saturation.Enabled = true
			params.Saturation.Amount = 20
			params.DitherBits = 16
			streamed, err := renderedReferenceSpectrumContext(context.Background(), source, params, spectrumEdges)
			if err != nil {
				t.Fatal(err)
			}
			rendered := *source
			rendered.Left = make([]float32, source.Frames)
			rendered.Right = make([]float32, source.Frames)
			engine := dsp.NewEngine(float64(rate))
			engine.SetParams(params)
			engine.ProcessBlock(source.Left, source.Right, rendered.Left, rendered.Right)
			powers, err := referenceSpectrum(context.Background(), &rendered, spectrumEdges)
			if err != nil {
				t.Fatal(err)
			}
			for band := range powers {
				if math.Abs(streamed[band]-powers[band]) > 1e-12 {
					t.Fatalf("rate%d duration%g band%d: streamed %.15g full %.15g", rate, seconds, band, streamed[band], powers[band])
				}
			}
		}
	}
}

func TestReferenceExportAlgorithmsKeepAlignedSpectrumAndTail(t *testing.T) {
	for _, algorithm := range []uint32{0, 1, 2, 3} {
		for _, rate := range []int{8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000} {
			for _, frames := range []int{1, 17, 4095, 4097, rate/8 + 3} {
				t.Run(fmt.Sprintf("algorithm%d/rate%d/frames%d", algorithm, rate, frames), func(t *testing.T) {
					source := &audio.Buffer{SampleRate: rate, Channels: 2, Frames: frames, Duration: float64(frames) / float64(rate), Left: make([]float32, frames), Right: make([]float32, frames)}
					for i := range source.Left {
						at := float64(i) / float64(rate)
						source.Left[i] = float32(.04 + .7*math.Sin(2*math.Pi*83*at) + .4*math.Sin(2*math.Pi*2700*at))
						source.Right[i] = source.Left[i]*.8 - .02
					}
					// An abrupt asymmetric final sample makes a missing Drain observable,
					// even when the whole source is shorter than buffered latency.
					source.Left[frames-1], source.Right[frames-1] = 1.4, -.9
					params := dsp.DefaultParams()
					params.AlgorithmVersion, params.InputGainDB, params.DitherBits = algorithm, 6, 16
					params.Compressor.Enabled, params.Compressor.ThresholdDB, params.Compressor.Ratio = true, -18, 2
					params.Saturation.Enabled, params.Saturation.Character, params.Saturation.Amount = true, dsp.SatTube, 45
					params.Limiter.Enabled, params.Limiter.TruePeak = true, algorithm >= 2
					expectedL, expectedR, _, err := dsp.RenderBufferContext(context.Background(), source.Left, source.Right, float64(rate), params)
					if err != nil {
						t.Fatal(err)
					}
					engine := dsp.NewEngine(float64(rate))
					engine.SetParams(params)
					reader, err := newReferenceRenderReader(source, engine)
					if err != nil {
						t.Fatal(err)
					}
					actualL, actualR := make([]float32, frames), make([]float32, frames)
					for start := 0; start < frames; start += 137 {
						end := min(start+137, frames)
						if err := reader.read(context.Background(), actualL[start:end], actualR[start:end]); err != nil {
							t.Fatal(err)
						}
					}
					for i := range actualL {
						if actualL[i] != expectedL[i] || actualR[i] != expectedR[i] {
							t.Fatalf("aligned frame%d: got %g/%g want %g/%g", i, actualL[i], actualR[i], expectedL[i], expectedR[i])
						}
					}
					var expectedMoments stereoMoments
					for i, left := range expectedL {
						expectedMoments.add(float64(left), float64(expectedR[i]))
					}
					moments, err := renderedStereoMoments(context.Background(), source, params)
					if err != nil {
						t.Fatal(err)
					}
					if moments != expectedMoments {
						t.Fatalf("width moments differ from source-length export: got%+v want%+v", moments, expectedMoments)
					}
					rendered := *source
					rendered.Left, rendered.Right = expectedL, expectedR
					powers, err := referenceSpectrum(context.Background(), &rendered, spectrumEdges)
					if err != nil {
						t.Fatal(err)
					}
					streamed, err := renderedReferenceSpectrumContext(context.Background(), source, params, spectrumEdges)
					if err != nil {
						t.Fatal(err)
					}
					for band := range powers {
						if math.Abs(streamed[band]-powers[band]) > 1e-12 {
							t.Fatalf("band%d: streamed%.15g full%.15g", band, streamed[band], powers[band])
						}
					}
				})
			}
		}
	}
}

type referenceCancelContext struct {
	context.Context
	checks int
}

func (c *referenceCancelContext) Err() error {
	c.checks++
	if c.checks > 1 {
		return context.Canceled
	}
	return nil
}

func TestReferenceRenderCancelsBetweenBoundedChunks(t *testing.T) {
	source := featureSignal(48000, 1, func(int) (float32, float32) { return .1, .2 })
	engine := dsp.NewEngine(48000)
	reader, err := newReferenceRenderReader(source, engine)
	if err != nil {
		t.Fatal(err)
	}
	ctx := &referenceCancelContext{Context: context.Background()}
	if err := reader.read(ctx, make([]float32, 8192), make([]float32, 8192)); !errors.Is(err, context.Canceled) {
		t.Fatal("missing bounded cancellation", err)
	}
	if reader.input != 4096 {
		t.Fatal("processed beyond one cancellable chunk", reader.input)
	}
}

func TestReferenceProposalsPreserveSelectedExportAlgorithm(t *testing.T) {
	for _, algorithm := range []uint32{2, 3} {
		t.Run(fmt.Sprintf("algorithm%d", algorithm), func(t *testing.T) {
			makeSource := func(reference bool) *audio.Buffer {
				return featureSignal(48000, .25, func(i int) (float32, float32) {
					at, value := float64(i)/48000, 0.0
					for band, frequency := range []float64{60, 250, 997, 2800, 9000} {
						level := .05
						if reference {
							level *= .7 + .15*float64(band)
						}
						value += level * math.Sin(2*math.Pi*frequency*at)
					}
					side := .02 * math.Sin(2*math.Pi*3001*at)
					return float32(value + side), float32(value - side)
				})
			}
			baseline := dsp.DefaultParams()
			baseline.AlgorithmVersion = algorithm
			baseline.Limiter.Enabled, baseline.Limiter.TruePeak = true, true
			baseline.Stereo.Enabled = true
			proposal, err := MatchReferenceContext(context.Background(), makeSource(false), makeSource(true), baseline, ReferenceOptions{Amount: .62, ProtectBelowHz: 120, IncludeWidth: true}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if proposal.Baseline != baseline || proposal.Params.AlgorithmVersion != algorithm {
				t.Fatal("the measured or proposed chain changed the selected export algorithm")
			}
		})
	}
}
