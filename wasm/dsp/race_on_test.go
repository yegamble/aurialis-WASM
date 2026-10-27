//go:build race

package main

// raceEnabled reports whether the race detector is on. The live/export parity
// tests shorten their signals and rates under the detector, and the true-peak
// ceiling matrix runs one rate; CI runs the full versions in separate non-race
// steps.
const raceEnabled = true
