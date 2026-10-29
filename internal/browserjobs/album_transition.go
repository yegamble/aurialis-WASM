package browserjobs

import (
	"context"
	"errors"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

// transition mixes only a bounded pair of already rendered album edges. The
// untouched bodies of the individual masters never pass through this encoder.
func transition(ctx context.Context, request Request, source, reference []byte) (*Result, error) {
	// Five seconds at the largest supported rate, stereo float WAV, per edge.
	const edgeBytes = 44 + 5*192000*8
	if len(source) > edgeBytes || len(reference) > edgeBytes {
		return nil, errors.New("album crossfades accept at most five seconds per edge")
	}
	a, err := audio.DecodeAndDisarm("edge.wav", source)
	if err != nil {
		return nil, err
	}
	defer audio.ReleasePCM(a.Left)
	defer audio.ReleasePCM(a.Right)
	b, err := audio.DecodeAndDisarm("edge.wav", reference)
	if err != nil {
		return nil, err
	}
	defer audio.ReleasePCM(b.Left)
	defer audio.ReleasePCM(b.Right)
	n := len(a.Left)
	if n < 8 || n != len(b.Left) || a.SampleRate != b.SampleRate || n > 5*a.SampleRate {
		return nil, errors.New("album crossfade edges require equal lengths and sample rates within five seconds")
	}
	if request.BitDepth != 16 && request.BitDepth != 24 && request.BitDepth != 32 {
		return nil, errors.New("album crossfade bit depth must be 16, 24 or 32")
	}
	for i := range a.Left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		mix := float64(i) / float64(n-1)
		a.Left[i] = float32(float64(a.Left[i])*(1-mix) + float64(b.Left[i])*mix)
		a.Right[i] = float32(float64(a.Right[i])*(1-mix) + float64(b.Right[i])*mix)
	}
	// Original masters are already quantized. Quantize only the new overlap,
	// without introducing a second dither pass into the retained track bodies.
	wav, err := audio.EncodeWAV(a.Left, a.Right, a.SampleRate, request.BitDepth)
	if err != nil {
		return nil, err
	}
	return &Result{Metadata: []byte(`{"kind":"album_transition"}`), Audio: wav}, nil
}
