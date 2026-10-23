// Package automation compiles bounded source-frame envelopes shared by native and WASI rendering.
package automation

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
)

const (
	// MaxMoves bounds one immutable schedule.
	MaxMoves = 128
	// MaxPoints bounds authored envelope points per move.
	MaxPoints = 256
	// TargetCount is the closed number of initially supported scalar targets.
	TargetCount = 10
	// MaxSourceFrames retains the canonical PCM frame admission limit.
	MaxSourceFrames = 16 * 1024 * 1024
)

// Target identifies a fixed control, never an evaluated object path.
type Target uint8

const (
	// InputGain is evaluated at each source-time sample before all processing.
	InputGain Target = iota
	// EQ0 through EQ4 address the five explicit band gains.
	EQ0
	// EQ1 addresses band 1 gain.
	EQ1
	// EQ2 addresses band 2 gain.
	EQ2
	// EQ3 addresses band 3 gain.
	EQ3
	// EQ4 addresses band 4 gain.
	EQ4
	// CompressorThreshold and CompressorRatio retain the baseline module enable.
	CompressorThreshold
	// CompressorRatio retains the baseline compressor enable.
	CompressorRatio
	// SaturationAmount retains the baseline character and enable.
	SaturationAmount
	// Width is evaluated at the original stereo stage before limiting.
	Width
)

// Values is a complete scalar snapshot relative to an immutable chain baseline.
type Values [TargetCount]float64

// Metadata defines authoritative bounds and conservative held-control error limits.
type Metadata struct {
	Name           string  `json:"name"`
	Minimum        float64 `json:"minimum"`
	Maximum        float64 `json:"maximum"`
	CellTolerance  float64 `json:"cellTolerance"`
	SampleAccurate bool    `json:"sampleAccurate"`
}

// Targets returns the closed allowlist. Tolerances are parameter errors, not audio guarantees.
func Targets() [TargetCount]Metadata {
	return [TargetCount]Metadata{
		{"inputGainDb", -36, 36, 0, true},
		{"eq.0.gainDb", -24, 24, 0.1, false}, {"eq.1.gainDb", -24, 24, 0.1, false}, {"eq.2.gainDb", -24, 24, 0.1, false}, {"eq.3.gainDb", -24, 24, 0.1, false}, {"eq.4.gainDb", -24, 24, 0.1, false},
		{"compressor.thresholdDb", -80, 12, 0.1, false}, {"compressor.ratio", 1, 100, 0.01, false}, {"saturation.amount", 0, 100, 0.1, false}, {"stereo.widthPct", 0, 200, 0, true},
	}
}

// ParseTarget rejects unsupported fields, including every unvalidated repair target.
func ParseTarget(name string) (Target, error) {
	for index, target := range Targets() {
		if target.Name == name {
			return Target(index), nil
		}
	} // #nosec G115 -- ten fixed targets
	return 0, fmt.Errorf("unsupported automation target %q", name)
}

// Point binds one finite value to an integer source frame.
type Point struct {
	Frame int64   `json:"frame"`
	Value float64 `json:"value"`
}

// Move is an authored half-open envelope. Absolute/add are the only operations.
type Move struct {
	ID         string  `json:"id"`
	SectionID  string  `json:"sectionId"`
	Reason     string  `json:"reason"`
	Target     string  `json:"target"`
	Operation  string  `json:"operation"`
	Points     []Point `json:"points"`
	FadeFrames int     `json:"fadeFrames"`
	Muted      bool    `json:"muted"`
}

type compiledMove struct {
	target Target
	count  int
	points [MaxPoints]Point
	fade   float64
	muted  bool
}

// Schedule owns fixed-capacity immutable points and target indexes. Prepare it off the audio thread.
type Schedule struct {
	sourceRate int
	deviceRate int
	frames     int64
	revision   uint64
	baseline   Values
	quantum    int
	moves      [MaxMoves]compiledMove
	byTarget   [TargetCount][MaxMoves]uint8
	counts     [TargetCount]int
	used       [TargetCount]bool
	count      int
}

// CompileContext validates, coalesces collinear points and bounds held-control error analytically.
// Compile cost depends on bounded authored points, never the song's duration or device sample count.
func CompileContext(ctx context.Context, sourceRate, deviceRate int, frames int64, revision uint64, baseline Values, moves []Move) (*Schedule, error) {
	if ctx == nil {
		return nil, errors.New("context required")
	}
	if sourceRate < 8000 || sourceRate > 192000 || deviceRate < 8000 || deviceRate > 192000 || frames < 1 || frames > MaxSourceFrames || revision < 1 || revision > 1<<53-1 || len(moves) > MaxMoves {
		return nil, errors.New("invalid schedule layout, revision or move count")
	}
	schedule := &Schedule{sourceRate: sourceRate, deviceRate: deviceRate, frames: frames, revision: revision, baseline: baseline, quantum: max(1, deviceRate/1000), count: len(moves)}
	metadata := Targets()
	for index, value := range baseline {
		if !finite(value) || value < metadata[index].Minimum || value > metadata[index].Maximum {
			return nil, errors.New("invalid automation baseline")
		}
	}
	ids := make(map[string]bool, len(moves))
	for index, move := range moves {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if move.ID == "" || len(move.ID) > 128 || ids[move.ID] || len(move.Reason) > 2048 || len(move.Points) < 2 || len(move.Points) > MaxPoints || (move.Operation != "absolute" && move.Operation != "add") {
			return nil, errors.New("invalid or duplicate automation move")
		}
		ids[move.ID] = true
		target, err := ParseTarget(move.Target)
		if err != nil {
			return nil, err
		}
		compiled := &schedule.moves[index]
		compiled.target, compiled.fade, compiled.muted = target, float64(move.FadeFrames), move.Muted
		low, high := metadata[target].Minimum, metadata[target].Maximum
		for pointIndex, point := range move.Points {
			if point.Frame < 0 || point.Frame > frames || !finite(point.Value) || (pointIndex > 0 && point.Frame <= move.Points[pointIndex-1].Frame) {
				return nil, errors.New("invalid automation points")
			}
			if move.Operation == "add" {
				point.Value += baseline[target]
			}
			if point.Value < low || point.Value > high {
				return nil, fmt.Errorf("%s envelope exceeds authoritative bounds", move.Target)
			}
			// Remove only collinear interior points; processing remains independent of authored density.
			for compiled.count >= 2 {
				a, b := compiled.points[compiled.count-2], compiled.points[compiled.count-1]
				predicted := a.Value + (point.Value-a.Value)*float64(b.Frame-a.Frame)/float64(point.Frame-a.Frame)
				if math.Abs(predicted-b.Value) > 1e-12 {
					break
				}
				compiled.count--
			}
			compiled.points[compiled.count] = point
			compiled.count++
		}
		first, last := compiled.points[0].Frame, compiled.points[compiled.count-1].Frame
		if move.FadeFrames < 0 || int64(move.FadeFrames) > (last-first)/2 || move.FadeFrames > sourceRate/10 {
			return nil, errors.New("fade must fit half the interval and at most 100 ms")
		}
		if !metadata[target].SampleAccurate {
			cellWidth := float64(schedule.Quantum()) * float64(sourceRate) / float64(deviceRate)
			if err := validateBandwidth(compiled, baseline[target], cellWidth, metadata[target]); err != nil {
				return nil, err
			}
		}
		count := schedule.counts[target]
		schedule.byTarget[target][count] = uint8(index) // #nosec G115 -- at most 128 moves
		schedule.counts[target]++
		if !move.Muted {
			schedule.used[target] = true
		}
	}
	for target := range TargetCount {
		indexes := schedule.byTarget[target][:schedule.counts[target]]
		sort.Slice(indexes, func(i, j int) bool {
			return schedule.moves[indexes[i]].points[0].Frame < schedule.moves[indexes[j]].points[0].Frame
		})
		for i := 1; i < len(indexes); i++ {
			previous, current := &schedule.moves[indexes[i-1]], &schedule.moves[indexes[i]]
			if previous.points[previous.count-1].Frame > current.points[0].Frame {
				return nil, errors.New("overlapping automation target intervals")
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return schedule, nil
}

func validateBandwidth(move *compiledMove, base, cellWidth float64, metadata Metadata) error {
	// A globally continuous envelope with this derivative bound cannot vary by
	// more than tolerance inside any device cell, even across multiple knots.
	// Nonneutral discontinuities require a fade rather than an ambiguous hold.
	budget := metadata.CellTolerance
	start, end := float64(move.points[0].Frame), float64(move.points[move.count-1].Frame)
	if move.fade == 0 && (math.Abs(move.points[0].Value-base) > 1e-12 || math.Abs(move.points[move.count-1].Value-base) > 1e-12) {
		return bandwidthError(metadata)
	}
	var cuts [MaxPoints + 2]float64
	count := move.count
	for i := 0; i < count; i++ {
		cuts[i] = float64(move.points[i].Frame)
	}
	if move.fade > 0 {
		cuts[count], cuts[count+1] = start+move.fade, end-move.fade
		count += 2
	}
	sort.Float64s(cuts[:count])
	for i := 1; i < count; i++ {
		left, right := cuts[i-1], cuts[i]
		if right == left {
			continue
		}
		middle := (left + right) / 2
		value, slope := move.envelope(middle)
		weight, weightSlope := 1.0, 0.0
		if move.fade > 0 {
			if middle < start+move.fade {
				weight = (middle - start) / move.fade
				weightSlope = 1 / move.fade
			} else if middle > end-move.fade {
				weight = (end - middle) / move.fade
				weightSlope = -1 / move.fade
			}
		}
		derivative := weightSlope*(value-base) + weight*slope
		curvature := 2 * weightSlope * slope
		maximum := math.Max(math.Abs(derivative+curvature*(left-middle)), math.Abs(derivative+curvature*(right-middle)))
		if maximum*cellWidth > budget+1e-12 {
			return bandwidthError(metadata)
		}
	}
	return nil
}

func bandwidthError(metadata Metadata) error {
	return fmt.Errorf("%s curve exceeds %.4g parameter error per <=1 ms cell; extend the fade or reduce the change", metadata.Name, metadata.CellTolerance)
}
func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func (move *compiledMove) envelope(frame float64) (float64, float64) {
	index := sort.Search(move.count, func(i int) bool { return float64(move.points[i].Frame) >= frame })
	if index == 0 {
		return move.points[0].Value, 0
	}
	if index == move.count {
		return move.points[index-1].Value, 0
	}
	left, right := move.points[index-1], move.points[index]
	slope := (right.Value - left.Value) / float64(right.Frame-left.Frame)
	return left.Value + (frame-float64(left.Frame))*slope, slope
}

// Used reports whether an unmuted target needs automation lanes or periodic updates.
func (schedule *Schedule) Used(target Target) bool {
	return target < TargetCount && schedule.used[target]
}

// ValueAt evaluates the authored source-time envelope against the baseline exactly once.
func (schedule *Schedule) ValueAt(target Target, sourceFrame float64) float64 {
	if schedule == nil || target >= TargetCount || !finite(sourceFrame) {
		return 0
	}
	base := schedule.baseline[target]
	indexes := schedule.byTarget[target][:schedule.counts[target]]
	index := sort.Search(len(indexes), func(i int) bool {
		move := &schedule.moves[indexes[i]]
		return float64(move.points[move.count-1].Frame) > sourceFrame
	})
	if index == len(indexes) {
		return base
	}
	move := &schedule.moves[indexes[index]]
	start, end := float64(move.points[0].Frame), float64(move.points[move.count-1].Frame)
	if move.muted || sourceFrame < start || sourceFrame >= end {
		return base
	}
	value, _ := move.envelope(sourceFrame)
	weight := 1.0
	if move.fade > 0 {
		weight = math.Min(1, math.Min((sourceFrame-start)/move.fade, (end-sourceFrame)/move.fade))
	}
	return base + (value-base)*weight
}

// Cursor retains an exact rational source clock and absolute device-time update lattice.
type Cursor struct {
	schedule    *Schedule
	numerator   int64
	deviceFrame int64
}

// NewCursor prepares a cursor at source frame zero.
func NewCursor(schedule *Schedule) *Cursor { return &Cursor{schedule: schedule} }

// SeekSourceFrame reconstructs envelopes; invalid requests leave the prior clock unchanged.
func (cursor *Cursor) SeekSourceFrame(sourceFrame int64) error {
	if cursor.schedule == nil || sourceFrame < 0 || sourceFrame > cursor.schedule.Frames() {
		return errors.New("seek exceeds bound source")
	}
	cursor.numerator = sourceFrame * int64(cursor.schedule.DeviceRate())
	cursor.deviceFrame = cursor.numerator / int64(cursor.schedule.SourceRate())
	return nil
}

// Fill returns a span ending at the absolute coefficient lattice, never at dense knots.
// Gain/width destinations have fixed caller-owned capacity; only used targets are filled.
func (cursor *Cursor) Fill(gain, width []float64, limit int) (int, Values) {
	if cursor == nil || cursor.schedule == nil || limit < 1 {
		return 0, Values{}
	}
	schedule := cursor.schedule
	span := min(limit, schedule.Quantum()-int(cursor.deviceFrame%int64(schedule.Quantum())))
	if schedule.Used(InputGain) {
		span = min(span, len(gain))
	}
	if schedule.Used(Width) {
		span = min(span, len(width))
	}
	cellStart := cursor.deviceFrame / int64(schedule.Quantum()) * int64(schedule.Quantum())
	heavyTime := float64(cellStart*int64(schedule.SourceRate())) / float64(schedule.DeviceRate())
	values := schedule.Baseline()
	for target := EQ0; target < Width; target++ {
		if schedule.Used(target) {
			values[target] = schedule.ValueAt(target, heavyTime)
		}
	}
	for i := 0; i < span; i++ {
		time := float64(cursor.numerator) / float64(schedule.DeviceRate())
		if schedule.Used(InputGain) {
			gain[i] = schedule.ValueAt(InputGain, time)
		}
		if schedule.Used(Width) {
			width[i] = schedule.ValueAt(Width, time)
		}
		cursor.numerator += int64(schedule.SourceRate())
		cursor.deviceFrame++
	}
	return span, values
}

// SourceRate returns the canonical source rate.
func (schedule *Schedule) SourceRate() int { return schedule.sourceRate }

// DeviceRate returns the compiled processing rate.
func (schedule *Schedule) DeviceRate() int { return schedule.deviceRate }

// Frames returns the bound source length.
func (schedule *Schedule) Frames() int64 { return schedule.frames }

// Revision returns the explicit schedule revision.
func (schedule *Schedule) Revision() uint64 { return schedule.revision }

// Baseline returns a copy of the immutable scalar baseline.
func (schedule *Schedule) Baseline() Values { return schedule.baseline }

// Quantum returns the absolute held-control cell size in device frames.
func (schedule *Schedule) Quantum() int { return schedule.quantum }
