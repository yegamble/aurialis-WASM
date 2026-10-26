//go:build race

package server_test

// raceEnabled reports whether the race detector is on; timing calibration
// skips because instrumentation inflates the measured cost.
const raceEnabled = true
