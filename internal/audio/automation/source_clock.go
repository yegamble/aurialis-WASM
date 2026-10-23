package automation

// NewSourceClock binds an exact phase-zero transport clock without a schedule.
// Hosts bind before the source epoch and call no processing during hold/pause.
// The clock itself has fixed scalar storage and infers no wall-clock time.
func NewSourceClock(sourceRate, deviceRate int, frames int64) (Cursor, bool) {
	cursor := Cursor{sourceRate: sourceRate, deviceRate: deviceRate, frames: frames}
	if !cursor.validClockLayout() {
		return Cursor{}, false
	}
	return cursor, true
}

func (cursor *Cursor) validClockLayout() bool {
	return cursor != nil && cursor.sourceRate >= 8000 && cursor.sourceRate <= 192000 && cursor.deviceRate >= 8000 && cursor.deviceRate <= 192000 && cursor.frames >= 1 && cursor.frames <= MaxSourceFrames
}
