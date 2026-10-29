//go:build race

package dsp

// raceEnabled reports whether the race detector is on. Long audio
// verification shortens its fixtures under the detector; the non-race run
// keeps the full length.
const raceEnabled = true
