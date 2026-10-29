package mastering

import (
	"errors"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// RenderQualityAlgorithm maps the closed, persisted quality choice. Missing
// quality retains classic exports; choosing oversampled is always explicit.
func RenderQualityAlgorithm(quality string) (uint32, error) {
	switch quality {
	case "", "classic":
		return dsp.TruePeakAlgorithmVersion, nil
	case "oversampled":
		return dsp.OversampledAlgorithmVersion, nil
	default:
		return 0, errors.New("renderQuality must be classic or oversampled")
	}
}
