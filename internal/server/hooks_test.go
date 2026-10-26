package server

import (
	"context"
	"time"
)

// Deadline math under test in the external server_test package.
var (
	ExportBudget   = exportBudget
	TransferBudget = transferBudget
)

// Deadline constants under test.
const (
	PostRequestTimeout = postRequestTimeout
	MaxExportBudget    = maxExportBudget
	MaxTransferTime    = maxTransferTime
)

// SetRequestTimingForTest replaces the base POST deadline and the export
// budget, and runs started (when non-nil) once the export budget is in force,
// so tests can stand in for slow renders without real minutes of DSP.
func SetRequestTimingForTest(s *Server, base time.Duration, budget func(frames, sourceRate, outputRate int) time.Duration, started func(context.Context)) {
	s.postTimeout, s.exportBudget, s.exportStarted = base, budget, started
}
