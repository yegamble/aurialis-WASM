package mastering

// cspell:words RMSDB

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"math/cmplx"
	"sort"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

const (
	featureFloorDB        = -120.0
	featureWindowSeconds  = 1.0
	featureHopSeconds     = 0.25
	minimumSectionSeconds = 8.0
)

// SourceIdentity binds analysis to interleaved canonical stereo float PCM and layout.
// The SHA-256 input is little-endian rate, channel count, frame count, then L/R floats.
type SourceIdentity struct {
	PCMHash    string `json:"pcmHash"`
	SampleRate int    `json:"sampleRate"`
	Frames     int64  `json:"frames"`
}

// SpectrumBand reports mean-square stereo power and power density over usable bandwidth.
// An unavailable band has Valid false and the finite reporting floor, not measured silence.
type SpectrumBand struct {
	LowHz          float64 `json:"lowHz"`
	HighHz         float64 `json:"highHz"`
	UsableHighHz   float64 `json:"usableHighHz"`
	BandwidthHz    float64 `json:"bandwidthHz"`
	PowerDB        float64 `json:"powerDb"`
	DensityDBPerHz float64 `json:"densityDbPerHz"`
	Valid          bool    `json:"valid"`
}

// FeatureFrame summarizes a one-second window, clipped to the source for short files.
type FeatureFrame struct {
	CenterFrame int64   `json:"centerFrame"`
	RMSDB       float64 `json:"rmsDb"`
	CentroidHz  float64 `json:"centroidHz"`
	SideMidDB   float64 `json:"sideMidDb"`
	CrestDB     float64 `json:"crestDb"`
}

// FeatureSection is a neutral change-point interval, never an inferred musical role.
// Confidence is a bounded novelty-strength heuristic, not a calibrated probability.
type FeatureSection struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	StartFrame int64   `json:"startFrame"`
	EndFrame   int64   `json:"endFrame"`
	RoleHint   string  `json:"roleHint"`
	Confidence float64 `json:"confidence"`
}

// AnalysisFeatures contains measured summaries only; it proposes no processing moves.
type AnalysisFeatures struct {
	Version                string           `json:"version"`
	Source                 SourceIdentity   `json:"source"`
	WindowSeconds          float64          `json:"windowSeconds"`
	HopSeconds             float64          `json:"hopSeconds"`
	FFTSize                int              `json:"fftSize"`
	Bands                  [5]SpectrumBand  `json:"bands"`
	SibilanceRatioDB       float64          `json:"sibilanceRatioDb"`
	WindowCrestPercentiles [3]float64       `json:"windowCrestPercentiles"`
	Frames                 []FeatureFrame   `json:"frames"`
	Sections               []FeatureSection `json:"sections"`
	Warnings               []string         `json:"warnings"`
}

type spectralSummary struct {
	start, end                                    int
	power, midPower, sidePower, peak              float64
	bands                                         [5]float64
	spectralPower, frequencyPower, sibilancePower float64
}

var spectrumEdges = [6]float64{20, 120, 500, 2000, 6000, 20000}

// AnalyzeFeaturesContext measures normalized Hann FFT powers and neutral change points.
// Short FFT summaries are aggregated over one second at quarter-second hops. Scratch
// is bounded by MaxDecodedFrames; this function belongs in a background job, not DSP.
func AnalyzeFeaturesContext(ctx context.Context, buf *audio.Buffer, onProgress func(int, string)) (*AnalysisFeatures, error) {
	if err := validateStereoBuffer(ctx, buf); err != nil {
		return nil, err
	}
	identity, err := sourceIdentityContext(ctx, buf)
	if err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(10, "Measuring normalized spectrum and stereo energy...")
	}
	// Resolve the 20–120 Hz band even at 192 kHz. A fixed 4096 FFT there
	// has 46.875 Hz bins and cannot contain the Hann spread of upper bass tones.
	fftSize := 1024
	for fftSize < buf.SampleRate/16 && fftSize < 16384 {
		fftSize *= 2
	}
	summaries, total, err := measureSpectrumContext(ctx, buf, fftSize)
	if err != nil {
		return nil, err
	}
	result := &AnalysisFeatures{
		Version: "1.0", Source: identity, WindowSeconds: featureWindowSeconds,
		HopSeconds: featureHopSeconds, FFTSize: fftSize, Warnings: []string{},
	}
	frames := float64(len(buf.Left))
	nyquist := float64(buf.SampleRate) / 2
	for i := range result.Bands {
		low, high := spectrumEdges[i], spectrumEdges[i+1]
		usable := math.Max(low, math.Min(high, nyquist))
		band := SpectrumBand{LowHz: low, HighHz: high, UsableHighHz: usable, BandwidthHz: usable - low, PowerDB: featureFloorDB, DensityDBPerHz: featureFloorDB, Valid: usable > low}
		if band.Valid {
			power := total.bands[i] / frames
			band.PowerDB = powerDB(power)
			band.DensityDBPerHz = powerDB(power / band.BandwidthHz)
		}
		if usable < high {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Band %.0f–%.0f Hz has limited or unavailable bandwidth at this sample rate.", low, high))
		}
		result.Bands[i] = band
	}
	result.SibilanceRatioDB = featureFloorDB
	if total.spectralPower > 1e-20 {
		result.SibilanceRatioDB = ratioDB(total.sibilancePower, total.spectralPower)
	}
	if onProgress != nil {
		onProgress(65, "Aggregating one-second features and neutral change points...")
	}
	result.Frames, err = aggregateFeatureFrames(ctx, summaries, buf)
	if err != nil {
		return nil, err
	}
	crests := make([]float64, len(result.Frames))
	for i, frame := range result.Frames {
		crests[i] = frame.CrestDB
	}
	sort.Float64s(crests)
	for i, percentile := range []float64{0.1, 0.5, 0.9} {
		result.WindowCrestPercentiles[i] = crests[int(percentile*float64(len(crests)-1))]
	}
	result.Sections, err = detectFeatureSections(ctx, result.Frames, summaries, len(buf.Left), buf.SampleRate)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(100, "Measured features ready; no musical roles or processing inferred")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func sourceIdentityContext(ctx context.Context, buf *audio.Buffer) (SourceIdentity, error) {
	hash := sha256.New()
	var header [16]byte
	binary.LittleEndian.PutUint32(header[:4], uint32(buf.SampleRate)) // #nosec G115 -- rate validated 8000..192000
	binary.LittleEndian.PutUint32(header[4:8], 2)
	binary.LittleEndian.PutUint64(header[8:], uint64(len(buf.Left)))
	_, _ = hash.Write(header[:])
	var block [4096 * 8]byte
	for start := 0; start < len(buf.Left); start += 4096 {
		if err := ctx.Err(); err != nil {
			return SourceIdentity{}, err
		}
		count := min(4096, len(buf.Left)-start)
		for j := 0; j < count; j++ {
			binary.LittleEndian.PutUint32(block[j*8:], math.Float32bits(buf.Left[start+j]))
			binary.LittleEndian.PutUint32(block[j*8+4:], math.Float32bits(buf.Right[start+j]))
		}
		_, _ = hash.Write(block[:count*8])
	}
	return SourceIdentity{PCMHash: hex.EncodeToString(hash.Sum(nil)), SampleRate: buf.SampleRate, Frames: int64(len(buf.Left))}, nil
}

func measureSpectrumContext(ctx context.Context, buf *audio.Buffer, fftSize int) ([]spectralSummary, spectralSummary, error) {
	// Remove only the whole-source DC mean from spectral analysis. Energy and
	// stereo diagnostics retain original samples; local means would attenuate bass.
	var meanLeft, meanRight float64
	for i := range buf.Left {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, spectralSummary{}, err
			}
		}
		meanLeft += float64(buf.Left[i])
		meanRight += float64(buf.Right[i])
	}
	meanLeft /= float64(len(buf.Left))
	meanRight /= float64(len(buf.Right))
	hop := fftSize / 4
	// Raw energy cells partition the source exactly. Overlapping spectral windows
	// never duplicate RMS, peak or Mid/Side samples in these time summaries.
	summaries := make([]spectralSummary, (len(buf.Left)+hop-1)/hop)
	for cell := range summaries {
		start, end := cell*hop, min((cell+1)*hop, len(buf.Left))
		raw, err := rawSummaryContext(ctx, buf, start, end)
		if err != nil {
			return nil, spectralSummary{}, err
		}
		summaries[cell] = raw
	}

	weights := make([]float64, fftSize)
	weightPower := 0.0
	for i := range weights {
		weights[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(fftSize))
		weightPower += weights[i] * weights[i]
	}
	scratch := make([]complex128, fftSize)
	var total spectralSummary
	// Periodic Hann squared windows at 75% overlap sum to exactly 1.5 for
	// every sample. Pad both ends and include every intersecting window, so
	// boundary transients receive the same power coverage as interior audio.
	for start := -3 * hop; start < len(buf.Left); start += hop {
		if err := ctx.Err(); err != nil {
			return nil, spectralSummary{}, err
		}
		clear(scratch)
		for i := range scratch {
			index := start + i
			if index >= 0 && index < len(buf.Left) {
				scratch[i] = complex((float64(buf.Left[index])-meanLeft)*weights[i], (float64(buf.Right[index])-meanRight)*weights[i])
			}
		}
		fftInPlace(scratch)
		var spectral spectralSummary
		for k := 0; k <= fftSize/2; k++ {
			frequency := float64(k) * float64(buf.SampleRate) / float64(fftSize)
			left := (scratch[k] + cmplx.Conj(scratch[(fftSize-k)%fftSize])) / 2
			right := (scratch[k] - cmplx.Conj(scratch[(fftSize-k)%fftSize])) / complex(0, 2)
			power := (real(left)*real(left) + imag(left)*imag(left) + real(right)*real(right) + imag(right)*imag(right)) / 2
			power /= float64(fftSize) * weightPower
			if k != 0 && k != fftSize/2 {
				power *= 2
			}
			binWidth := float64(buf.SampleRate) / float64(fftSize)
			binLow := math.Max(0, frequency-binWidth/2)
			binHigh := math.Min(float64(buf.SampleRate)/2, frequency+binWidth/2)
			fraction := func(low, high float64) float64 {
				return math.Max(0, math.Min(binHigh, high)-math.Max(binLow, low)) / (binHigh - binLow)
			}
			spectralPower := power * fraction(20, float64(buf.SampleRate)/2)
			spectral.spectralPower += spectralPower
			spectral.frequencyPower += frequency * spectralPower
			spectral.sibilancePower += power * fraction(6000, 12000)
			for band := range 5 {
				spectral.bands[band] += power * fraction(spectrumEdges[band], spectrumEdges[band+1])
			}
		}
		// Weight by the hop, not the full/edge window length: summed Hann
		// coverage divided by its full-window energy gives exactly one sample.
		addSummary(&total, spectral, float64(hop))
		cell := (start + fftSize/2) / hop
		if cell >= 0 && cell < len(summaries) {
			summaries[cell].bands = spectral.bands
			summaries[cell].spectralPower = spectral.spectralPower
			summaries[cell].frequencyPower = spectral.frequencyPower
			summaries[cell].sibilancePower = spectral.sibilancePower
		}
	}
	return summaries, total, nil
}

func rawSummaryContext(ctx context.Context, buf *audio.Buffer, start, end int) (spectralSummary, error) {
	summary := spectralSummary{start: start, end: end}
	for i := start; i < end; i++ {
		if i%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return spectralSummary{}, err
			}
		}
		left, right := float64(buf.Left[i]), float64(buf.Right[i])
		mid, side := (left+right)/2, (left-right)/2
		summary.power += (left*left + right*right) / 2
		summary.midPower += mid * mid
		summary.sidePower += side * side
		summary.peak = math.Max(summary.peak, math.Max(math.Abs(left), math.Abs(right)))
	}
	count := float64(end - start)
	summary.power /= count
	summary.midPower /= count
	summary.sidePower /= count
	return summary, nil
}

func fftInPlace(values []complex128) {
	n := len(values)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for length := 2; length <= n; length *= 2 {
		rotation := cmplx.Rect(1, -2*math.Pi/float64(length))
		for start := 0; start < n; start += length {
			phase := complex(1, 0)
			for j := 0; j < length/2; j++ {
				even, odd := values[start+j], values[start+j+length/2]*phase
				values[start+j], values[start+j+length/2] = even+odd, even-odd
				phase *= rotation
			}
		}
	}
}

func addSummary(total *spectralSummary, part spectralSummary, weight float64) {
	total.power += part.power * weight
	total.midPower += part.midPower * weight
	total.sidePower += part.sidePower * weight
	total.peak = math.Max(total.peak, part.peak)
	for i := range total.bands {
		total.bands[i] += part.bands[i] * weight
	}
	total.spectralPower += part.spectralPower * weight
	total.frequencyPower += part.frequencyPower * weight
	total.sibilancePower += part.sibilancePower * weight
}

func summarizeInterval(summaries []spectralSummary, start, end int) spectralSummary {
	total := spectralSummary{start: start, end: end}
	index := sort.Search(len(summaries), func(i int) bool { return summaries[i].end > start })
	for ; index < len(summaries) && summaries[index].start < end; index++ {
		part := summaries[index]
		weight := float64(min(end, part.end) - max(start, part.start))
		addSummary(&total, part, weight)
	}
	return total
}

func summaryFrame(summary spectralSummary) FeatureFrame {
	power := summary.power / float64(summary.end-summary.start)
	centroid := 0.0
	if summary.spectralPower > 1e-20 {
		centroid = summary.frequencyPower / summary.spectralPower
	}
	crest := 0.0
	if power > 1e-20 {
		crest = math.Max(0, powerDB(summary.peak*summary.peak)-powerDB(power))
	}
	return FeatureFrame{CenterFrame: int64((summary.start + summary.end) / 2), RMSDB: powerDB(power), CentroidHz: centroid, SideMidDB: ratioDB(summary.sidePower, summary.midPower), CrestDB: crest}
}

func aggregateFeatureFrames(ctx context.Context, summaries []spectralSummary, buf *audio.Buffer) ([]FeatureFrame, error) {
	frames, sampleRate := len(buf.Left), buf.SampleRate
	window := min(frames, sampleRate)
	hop := sampleRate / 4
	result := make([]FeatureFrame, 0, frames/hop+1)
	for start := 0; ; start += hop {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+window, frames)
		if end == frames {
			start = frames - window
		}
		summary := summarizeInterval(summaries, start, end)
		// Exact raw-window energy/peak is independent of FFT tiling and partial cells.
		raw, err := rawSummaryContext(ctx, buf, start, end)
		if err != nil {
			return nil, err
		}
		count := float64(end - start)
		summary.power = raw.power * count
		summary.midPower = raw.midPower * count
		summary.sidePower = raw.sidePower * count
		summary.peak = raw.peak
		result = append(result, summaryFrame(summary))
		if end == frames {
			break
		}
	}
	return result, nil
}

func powerDB(power float64) float64 {
	if power <= 1e-12 {
		return featureFloorDB
	}
	return 10 * math.Log10(power)
}

func ratioDB(numerator, denominator float64) float64 {
	if numerator <= 1e-20 && denominator <= 1e-20 {
		return 0
	}
	return math.Max(featureFloorDB, math.Min(120, 10*math.Log10(math.Max(numerator, 1e-20)/math.Max(denominator, 1e-20))))
}

func noveltyScales(frames []FeatureFrame) [3]float64 {
	values := [3][]float64{}
	for i := 1; i < len(frames); i++ {
		values[0] = append(values[0], math.Abs(frames[i].RMSDB-frames[i-1].RMSDB))
		values[1] = append(values[1], math.Abs(frames[i].CentroidHz-frames[i-1].CentroidHz))
		values[2] = append(values[2], math.Abs(frames[i].SideMidDB-frames[i-1].SideMidDB))
	}
	scales := [3]float64{1, 100, 3}
	for i, value := range values {
		if len(value) == 0 {
			continue
		}
		sort.Float64s(value)
		median := value[len(value)/2]
		for j := range value {
			value[j] = math.Abs(value[j] - median)
		}
		sort.Float64s(value)
		scales[i] = math.Max(scales[i], 1.4826*value[len(value)/2])
	}
	return scales
}

func featureNovelty(left, right FeatureFrame, scales [3]float64) float64 {
	return math.Abs(right.RMSDB-left.RMSDB)/scales[0] + math.Abs(right.CentroidHz-left.CentroidHz)/scales[1] + math.Abs(right.SideMidDB-left.SideMidDB)/scales[2]
}

type featureBoundary struct {
	frame int
	score float64
}

func detectFeatureSections(ctx context.Context, frames []FeatureFrame, summaries []spectralSummary, count, sampleRate int) ([]FeatureSection, error) {
	minimum := int(minimumSectionSeconds * float64(sampleRate))
	var candidates []featureBoundary
	if count >= minimum*2 {
		scales := noveltyScales(frames)
		scores := make([]float64, len(frames))
		for i := 2; i+2 < len(frames); i++ {
			scores[i] = featureNovelty(frames[i-2], frames[i+2], scales)
		}
		for i := 2; i+2 < len(frames); i++ {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if scores[i] < 3 || scores[i] < scores[i-1] || scores[i] < scores[i+1] {
				continue
			}
			center := int(frames[i].CenterFrame)
			best := featureBoundary{frame: center}
			begin := sort.Search(len(summaries), func(j int) bool { return summaries[j].start >= center-sampleRate })
			for j := begin; j < len(summaries) && summaries[j].start <= center+sampleRate; j++ {
				boundary := summaries[j].start
				if boundary < minimum || boundary > count-minimum {
					continue
				}
				left := summaryFrame(summarizeInterval(summaries, boundary-sampleRate/4, boundary))
				right := summaryFrame(summarizeInterval(summaries, boundary, boundary+sampleRate/4))
				score := featureNovelty(left, right, scales)
				if score > best.score {
					best = featureBoundary{frame: boundary, score: score}
				}
			}
			if best.score >= 3 {
				candidates = append(candidates, best)
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].score > candidates[j].score })
	selected := []featureBoundary{{frame: 0, score: 0}}
	for _, candidate := range candidates {
		separated := true
		for _, existing := range selected {
			if math.Abs(float64(candidate.frame-existing.frame)) < float64(minimum) {
				separated = false
				break
			}
		}
		if separated {
			selected = append(selected, candidate)
		}
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].frame < selected[j].frame })
	sections := make([]FeatureSection, len(selected))
	for i, boundary := range selected {
		end := count
		if i+1 < len(selected) {
			end = selected[i+1].frame
		}
		sections[i] = FeatureSection{ID: fmt.Sprintf("section-%d", i+1), Name: fmt.Sprintf("Section %d", i+1), StartFrame: int64(boundary.frame), EndFrame: int64(end), RoleHint: "unknown", Confidence: 1 - math.Exp(-boundary.score/8)}
	}
	return sections, nil
}

// StorageBytes conservatively charges the retained feature backing arrays and strings.
// Temporary FFT summaries are covered by the job's separate 16 MiB scratch reserve.
func (features *AnalysisFeatures) StorageBytes() int64 {
	if features == nil {
		return 0
	}
	return 4096 + int64(cap(features.Frames))*64 + int64(cap(features.Sections))*256 + int64(cap(features.Warnings))*256
}
