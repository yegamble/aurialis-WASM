package server

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"
)

const (
	// postRequestTimeout bounds every POST from admission through upload and
	// validation. Exports then switch to their work-proportional budget.
	postRequestTimeout = 60 * time.Second
	// Export work allowances, about 3x the measured native cost on an Apple
	// M-series core (0.7 µs per source frame to measure and render, 2.1 µs per
	// converted frame to resample, true-peak limit and measure) so slower CI
	// runners still finish.
	exportPerSourceFrame    = 2 * time.Microsecond
	exportPerConvertedFrame = 8 * time.Microsecond
	// maxExportBudget caps any export; the largest valid export
	// (33,554,432 source and converted frames) needs about 6.6 minutes.
	maxExportBudget = 10 * time.Minute

	// Uploads and downloads get 10 s plus 8 MiB/s of body, at most 60 s, so a
	// slow small body is cut off quickly while a 257 MiB loopback
	// upload or a converted WAV download has room.
	transferFloor          = 10 * time.Second
	transferBytesPerSecond = 8 << 20
	maxTransferTime        = 60 * time.Second
	// exportErrorWriteTime leaves room to write a JSON error once the export
	// budget ends.
	exportErrorWriteTime = 10 * time.Second
)

// exportBudget returns how long one export may run once its upload is
// validated: the base POST deadline plus an allowance per source frame and,
// when converting, per output frame, capped at maxExportBudget.
func exportBudget(frames, sourceRate, outputRate int) time.Duration {
	if frames <= 0 {
		return postRequestTimeout
	}
	work := float64(frames) * float64(exportPerSourceFrame)
	if sourceRate > 0 && outputRate > 0 && outputRate != sourceRate {
		converted := math.Ceil(float64(frames) * float64(outputRate) / float64(sourceRate))
		work += converted * float64(exportPerConvertedFrame)
	}
	if work >= float64(maxExportBudget-postRequestTimeout) {
		return maxExportBudget
	}
	return postRequestTimeout + time.Duration(work)
}

// transferBudget returns the read or write deadline for a body of n bytes;
// an unknown length (n < 0) gets the ceiling.
func transferBudget(n int64) time.Duration {
	if n < 0 || n >= int64(maxTransferTime-transferFloor)/int64(time.Second)*transferBytesPerSecond {
		return maxTransferTime
	}
	return transferFloor + time.Duration(n)*time.Second/transferBytesPerSecond
}

// exportBudgetError is the cancellation cause when an export overruns its budget.
type exportBudgetError struct{ budget time.Duration }

func (e *exportBudgetError) Error() string {
	return fmt.Sprintf("export exceeded its %s time budget", e.budget)
}

type uploadParentKey struct{}

// withPostDeadline bounds a POST with the base deadline and a body read
// deadline sized to its Content-Length. It keeps the connection context so
// an export can later replace the base deadline with its own budget.
func (s *Server) withPostDeadline(w http.ResponseWriter, r *http.Request) (*http.Request, context.CancelFunc) {
	if r.ContentLength >= 0 {
		setConnDeadline(http.NewResponseController(w).SetReadDeadline, transferBudget(r.ContentLength))
	}
	parent := r.Context()
	ctx, cancel := context.WithTimeout(context.WithValue(parent, uploadParentKey{}, parent), s.postTimeout)
	return r.WithContext(ctx), cancel
}

// withExportBudget replaces the base POST deadline with budget, measured from
// now, and extends the connection write deadline to match. A request whose
// base deadline already ended, or whose client left, is not revived.
func (s *Server) withExportBudget(w http.ResponseWriter, r *http.Request, budget time.Duration) (*http.Request, context.CancelFunc, bool) {
	if r.Context().Err() != nil {
		return r, func() {}, false
	}
	parent, ok := r.Context().Value(uploadParentKey{}).(context.Context)
	if !ok {
		parent = r.Context()
	}
	ctx, cancel := context.WithTimeoutCause(parent, budget, &exportBudgetError{budget: budget})
	setConnDeadline(http.NewResponseController(w).SetWriteDeadline, budget+exportErrorWriteTime)
	if s.exportStarted != nil {
		s.exportStarted(ctx)
	}
	return r.WithContext(ctx), cancel, true
}

// setConnDeadline sets a connection deadline d from now. The error is
// ignored: in-process handlers have no connection (http.ErrNotSupported), and
// on a closed connection the request context already ends the work.
func setConnDeadline(set func(time.Time) error, d time.Duration) {
	_ = set(time.Now().Add(d))
}

// writeExportCanceled reports an export stage that stopped because its
// budget ended (naming the next step) or because the client went away.
func writeExportCanceled(w http.ResponseWriter, r *http.Request, stage string) {
	var budgetErr *exportBudgetError
	if errors.As(context.Cause(r.Context()), &budgetErr) {
		writeErrorJSON(w, http.StatusRequestTimeout, "export_timeout", fmt.Sprintf(
			"%s exceeded the %s export time budget; export a shorter range, choose a lower sample rate or keep the source rate, then retry",
			stage, budgetErr.budget.Round(time.Second)))
		return
	}
	writeErrorJSON(w, http.StatusRequestTimeout, "canceled", stage+" canceled or timed out; retry the export")
}
