//go:build race

package main

// raceEnabled reports whether the race detector is on. Heavy audio
// verification runs a reduced matrix under the detector; CI runs the full
// matrix in a separate non-race step.
const raceEnabled = true
