package automation

// NumericMove is an already absolute/coalesced compiler output for bounded numeric staging.
// Preparing this slice and serializing it belongs off the audio thread.
type NumericMove struct {
	Target     Target  `json:"target"`
	FadeFrames int     `json:"fadeFrames"`
	Muted      bool    `json:"muted"`
	Points     []Point `json:"points"`
}

// NumericMoves exports independent numeric compiler output, with no identifiers or object paths.
func (schedule *Schedule) NumericMoves() []NumericMove {
	moves := make([]NumericMove, schedule.count)
	for i := range moves {
		compiled := &schedule.moves[i]
		moves[i] = NumericMove{Target: compiled.target, FadeFrames: int(compiled.fade), Muted: compiled.muted, Points: append([]Point{}, compiled.points[:compiled.count]...)}
	}
	return moves
}

// Builder owns a preallocated inactive schedule slot. Begin may reuse only a retired slot.
// Each stage validates/copies at most 256 numeric points. Finalize validates indexes without allocations.
type Builder struct {
	schedule Schedule
	received [MaxMoves]bool
	ready    bool
}

// Begin initializes bounded metadata without clearing the large point backing storage.
func (builder *Builder) Begin(sourceRate, deviceRate int, frames int64, revision uint64, baseline Values, count int) bool {
	if sourceRate < 8000 || sourceRate > 192000 || deviceRate < 8000 || deviceRate > 192000 || frames < 1 || frames > MaxSourceFrames || revision < 1 || revision > 1<<53-1 || count < 0 || count > MaxMoves {
		return false
	}
	metadata := Targets()
	for i, value := range baseline {
		if !finite(value) || value < metadata[i].Minimum || value > metadata[i].Maximum {
			return false
		}
	}
	schedule := &builder.schedule
	schedule.sourceRate, schedule.deviceRate, schedule.frames, schedule.revision, schedule.baseline, schedule.quantum, schedule.count = sourceRate, deviceRate, frames, revision, baseline, max(1, deviceRate/1000), count
	schedule.counts = [TargetCount]int{}
	schedule.used = [TargetCount]bool{}
	builder.received = [MaxMoves]bool{}
	builder.ready = true
	return true
}

// Stage validates one already compiled move and atomically replaces only its inactive slot.
func (builder *Builder) Stage(index int, target Target, fade int, muted bool, points []Point) bool {
	schedule := &builder.schedule
	if !builder.ready || index < 0 || index >= schedule.count || target >= TargetCount || len(points) < 2 || len(points) > MaxPoints {
		return false
	}
	compiled := compiledMove{target: target, fade: float64(fade), muted: muted, count: len(points)}
	metadata := Targets()[target]
	for i, point := range points {
		if !finite(point.Value) || point.Value < metadata.Minimum || point.Value > metadata.Maximum || point.Frame < 0 || point.Frame > schedule.frames || (i > 0 && point.Frame <= points[i-1].Frame) {
			return false
		}
		compiled.points[i] = point
	}
	duration := points[len(points)-1].Frame - points[0].Frame
	if fade < 0 || int64(fade) > duration/2 || fade > schedule.sourceRate/10 {
		return false
	}
	if !metadata.SampleAccurate && !withinBandwidth(&compiled, schedule.baseline[target], float64(schedule.quantum)*float64(schedule.sourceRate)/float64(schedule.deviceRate), metadata) {
		return false
	}
	schedule.moves[index] = compiled
	builder.received[index] = true
	return true
}

// Finalize seals an inactive slot after validating all moves and same-target interval exclusion.
// A failed finalization leaves the active schedule untouched and permits fixing the inactive slot.
func (builder *Builder) Finalize() (*Schedule, bool) {
	if !builder.ready {
		return nil, false
	}
	schedule := &builder.schedule
	schedule.counts = [TargetCount]int{}
	schedule.used = [TargetCount]bool{}
	for index := 0; index < schedule.count; index++ {
		if !builder.received[index] {
			return nil, false
		}
		move := &schedule.moves[index]
		target := move.target
		count := schedule.counts[target]
		insert := count
		for insert > 0 && schedule.moves[schedule.byTarget[target][insert-1]].points[0].Frame > move.points[0].Frame {
			schedule.byTarget[target][insert] = schedule.byTarget[target][insert-1]
			insert--
		}
		schedule.byTarget[target][insert] = uint8(index) // #nosec G115 -- count is capped at 128.
		schedule.counts[target]++
		schedule.used[target] = schedule.used[target] || !move.muted
	}
	for target := range TargetCount {
		for i := 1; i < schedule.counts[target]; i++ {
			previous := &schedule.moves[schedule.byTarget[target][i-1]]
			current := &schedule.moves[schedule.byTarget[target][i]]
			if previous.points[previous.count-1].Frame > current.points[0].Frame {
				return nil, false
			}
		}
	}
	builder.ready = false
	return schedule, true
}
