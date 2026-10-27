//go:build race

package mastering

// raceEnabled reports whether the race detector is on. Heavy audio
// verification shortens its fixtures under the detector; CI runs the
// full-length version in a separate non-race step.
const raceEnabled = true
