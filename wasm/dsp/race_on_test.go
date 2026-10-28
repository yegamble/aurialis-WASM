//go:build race

package main

// raceEnabled reports whether the race detector is on. The live/export parity
// tests shorten their signals and rates under the detector; CI runs the
// full-length versions in a separate non-race step.
const raceEnabled = true
