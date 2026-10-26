package steminfer

// cspell:words steminfer BLAS

import (
	"errors"
	"math"
	"runtime"
)

const modelSampleRate = 44100
const maximumPrivateJobBytes int64 = 1536 * 1024 * 1024

// maximumWorkers bounds transformer lanes; each lane adds about 20 MB at the
// full window.
const maximumWorkers = 16

// defaultWorkers uses every available core up to maximumWorkers.
func defaultWorkers() int { return min(runtime.GOMAXPROCS(0), maximumWorkers) }

type pipelineResources struct {
	sourceRate, sourceFrames, modelFrames, stems, heads, window, originalSpan, workers int
	staticModelBytes, graphBytes, overlapBytes, resampleBytes, streamBytes, groupBytes int64
	inputBytes, retainedOutputBytes, workingBytes, requiredJobBytes                    int64
}

func resampleRadius(fromRate, toRate int) int {
	if fromRate == toRate {
		return 0
	}
	return int(math.Ceil(32 / (.94 * math.Min(1, float64(toRate)/float64(fromRate)))))
}
func estimatePipeline(sourceRate, frames, stems, window, workers int) (pipelineResources, error) {
	if workers < 1 || workers > maximumWorkers || sourceRate < 8000 || sourceRate > 192000 || frames < 1 || frames > maximumSourceFrames || stems < 2 || stems > 6 || window <= fftSize/2 || window > maximumWindowSamples || window%2 != 0 {
		return pipelineResources{}, errors.New("invalid separation resource request")
	}
	modelFrames := (int64(frames)*modelSampleRate + int64(sourceRate) - 1) / int64(sourceRate)
	if modelFrames > maximumSourceFrames {
		return pipelineResources{}, errors.New("source is too long to separate")
	}
	heads := stems - 1
	if stems == 5 {
		heads = 5
	}
	inverseRadius := resampleRadius(modelSampleRate, sourceRate)
	span := min(frames, int((int64(window/2+inverseRadius+2)*int64(sourceRate)+modelSampleRate-1)/modelSampleRate)+2)
	result := pipelineResources{sourceRate: sourceRate, sourceFrames: frames, modelFrames: int(modelFrames), stems: stems, heads: heads, window: window, originalSpan: span, staticModelBytes: modelBytes, graphBytes: workingStorageBytes(window, workers), workers: workers}
	result.overlapBytes = int64(4+2*heads) * int64(window) * 4
	forwardRadius := resampleRadius(sourceRate, modelSampleRate)
	result.resampleBytes = int64(2*(forwardRadius+inverseRadius))*(resamplePhases+1)*4 +
		int64(kernelElements(sourceRate, modelSampleRate, forwardRadius)+kernelElements(modelSampleRate, sourceRate, inverseRadius))*8
	result.streamBytes = int64(heads) * int64(2*(2*inverseRadius+2)+2*outputBlockFrames) * 4
	result.groupBytes = int64(span)*2*8 + 2*outputBlockFrames*4
	if stems == 5 {
		result.groupBytes += int64(span) * 2 * 4
	}
	result.inputBytes = int64(frames) * 2 * 4
	result.retainedOutputBytes = int64(frames) * int64(stems) * 2 * 4
	result.workingBytes = result.graphBytes + result.overlapBytes + result.resampleBytes + result.streamBytes + result.groupBytes
	// Explicit conservative allowance for bounded Go descriptors and the OS BLAS
	// backend's opaque scratch. This is admission headroom, not an OS RSS promise.
	const backendAndMetadataAllowance = 32 * 1024 * 1024
	result.requiredJobBytes = result.workingBytes + result.inputBytes + result.retainedOutputBytes + backendAndMetadataAllowance
	if result.requiredJobBytes > maximumPrivateJobBytes {
		return pipelineResources{}, errors.New("separation job exceeds its 1.5 GiB memory ceiling")
	}
	return result, nil
}

// stemNames describes the actual selected heads and residual grouping. "other"
// is always original PCM minus the delivered selected groups, not a sixth
// independent neural head. The five-group melody combines guitar and piano.
func stemNames(stems int) ([6]string, error) {
	switch stems {
	case 2:
		return [6]string{"vocals", "instrumental"}, nil
	case 3:
		return [6]string{"vocals", "drums", "rest"}, nil
	case 4:
		return [6]string{"vocals", "drums", "bass", "other"}, nil
	case 5:
		return [6]string{"vocals", "drums", "bass", "melody", "other"}, nil
	case 6:
		return [6]string{"vocals", "drums", "bass", "guitar", "piano", "other"}, nil
	default:
		return [6]string{}, errors.New("invalid stem count")
	}
}
