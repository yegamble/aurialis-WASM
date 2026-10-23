package mastering

import (
	"context"
	"math"
	"testing"

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
