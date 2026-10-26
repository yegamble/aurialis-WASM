package dsp

import (
	"context"
	"errors"
	"math"
)

const (
	studioARMaxFrames     = 1024 * 1024
	studioARContext       = 4096
	studioARMaxOrder      = 32
	studioARMaxRun        = 256
	studioARMaxAttempts   = 128
	studioARTraceCapacity = 64
	studioARWorkLimit     = 32 * 1000 * 1000
	studioARMatrixCells   = (studioARMaxOrder + 1) * (studioARMaxOrder + 2)
)

type studioARUnresolvedReason uint8

const (
	studioARLongRun studioARUnresolvedReason = iota
	studioARBoundary
	studioARPlateau
	studioARBudget
	studioARUncertain
	studioARReasonCount
)

// This is a private, unqualified offline experiment, not an audio callback or
// public repair implementation. Known clipping threshold is required. Counts
// describe conservative estimates, not recovery of an unknowable original.
type studioARRunTrace struct {
	Start, End       int
	Reason           studioARUnresolvedReason
	Accepted, Cached bool
}

type studioARChannelReport struct {
	DetectedRuns, DetectedSamples, AttemptedRuns int
	AcceptedRuns, CachedRuns, ChangedSamples     int
	UnresolvedRuns, UnresolvedSamples            int
	Reasons                                      [studioARReasonCount]int
	Trace                                        [studioARTraceCapacity]studioARRunTrace
	TraceCount, OmittedTrace                     int
	WorkUnits                                    int64
	WorkExhausted                                bool
}

type studioARRepairReport struct {
	SampleRate, Threshold               float64
	MaxRunFrames, MaxAttemptsPerChannel int
	ContextFrames                       int
	WorkLimitPerChannel                 int64
	Channels                            [2]studioARChannelReport
}

type studioARContextData struct {
	values   [studioARContext]float64
	reliable [studioARContext]bool
	count    int
	work     *studioARWorkBudget
}

type studioARModelPair struct {
	forward, backward studioARModel
	valid             bool
}

type studioARModel struct {
	coefficients    [studioARMaxOrder + 1]float64
	order           int
	validationError float64
	sparseTone      bool
	work            *studioARWorkBudget
}

// The immutable original supplies every fit: accepted estimates never become
// evidence for a later run. Each channel has its own equal attempt budget.
// Unclipped, unsupported, long, edge and uncertain samples retain exact bytes.
// Threshold is canonicalized once to float32 so a requested .7 threshold agrees
// with the actual .7 plateau stored in float PCM. No source identity is changed.
// Admission caps output at 8 MiB stereo plus fixed local context/model scratch.
// Work is O(N) detection, fixed bounded validation per run, and at most128
// expensive refits per channel. Cached models must revalidate the CURRENT
// immutable context. Neither context size nor matrix size grows with N.
func repairStudioClippedPCM(ctx context.Context, rate, threshold float64, left, right []float32) ([]float32, []float32, studioARRepairReport, error) {
	var report studioARRepairReport
	if ctx == nil || !finite(rate) || rate < 8000 || rate > 192000 || !finite(threshold) || threshold < 1e-6 || threshold > 4 || len(left) == 0 || len(left) != len(right) || len(left) > studioARMaxFrames {
		return nil, nil, report, errors.New("invalid private clipping repair layout")
	}
	threshold = float64(float32(threshold))
	report.SampleRate, report.Threshold = rate, threshold
	report.MaxRunFrames = min(studioARMaxRun, max(4, int(math.Ceil(rate*.00075))))
	report.MaxAttemptsPerChannel = studioARMaxAttempts
	report.ContextFrames = min(studioARContext, max(256, int(math.Ceil(rate*.032))))
	report.WorkLimitPerChannel = studioARWorkLimit
	for i := range left {
		if i&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, report, err
			}
		}
		if !finite(float64(left[i])) || !finite(float64(right[i])) {
			return nil, nil, report, errors.New("nonfinite private clipping repair source")
		}
	}
	outLeft, outRight := make([]float32, len(left)), make([]float32, len(right))
	for start := 0; start < len(left); start += 4096 {
		if err := ctx.Err(); err != nil {
			return nil, nil, report, err
		}
		end := min(start+4096, len(left))
		copy(outLeft[start:end], left[start:end])
		copy(outRight[start:end], right[start:end])
	}
	var work studioARWorkBudget
	for channel, source := range [2][]float32{left, right} {
		output := outLeft
		if channel == 1 {
			output = outRight
		}
		if err := repairStudioARChannel(ctx, source, output, threshold, report.MaxRunFrames, report.ContextFrames, &work, &report.Channels[channel]); err != nil {
			return nil, nil, report, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, report, err
	}
	return outLeft, outRight, report, nil
}

func repairStudioARChannel(ctx context.Context, source, output []float32, threshold float64, maxRun, contextFrames int, work *studioARWorkBudget, report *studioARChannelReport) error {
	var cache studioARModelPair
	work.ctx, work.remaining, work.sincePoll, work.exhausted, work.err = ctx, studioARWorkLimit, 0, false, nil
	defer func() { report.WorkUnits = studioARWorkLimit - work.remaining; report.WorkExhausted = work.exhausted }()
	for frame := 0; frame < len(source); {
		if frame&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if math.Abs(float64(source[frame])) < threshold {
			frame++
			continue
		}
		start := frame
		for frame < len(source) && math.Abs(float64(source[frame])) >= threshold {
			if frame&4095 == 0 {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
			frame++
		}
		length := frame - start
		report.DetectedRuns++
		report.DetectedSamples += length
		reason := studioARUncertain
		var candidate *[studioARMaxRun]float64
		accepted, usedCache := false, false
		switch {
		case length > maxRun:
			reason = studioARLongRun
		case start == 0 || frame == len(source):
			reason = studioARBoundary
		case work.exhausted:
			reason = studioARBudget
		case !studioARKnownPlateau(source[start:frame], threshold):
			reason = studioARPlateau
		default:
			mayFit := report.AttemptedRuns < studioARMaxAttempts
			var err error
			var cached bool
			candidate, accepted, cached, err = estimateStudioARRun(ctx, source, start, frame, threshold, contextFrames, work, mayFit, &cache)
			if err != nil {
				return err
			}
			if work.err != nil {
				return work.err
			}
			if work.exhausted {
				reason = studioARBudget
			}
			usedCache = cached
			if cached {
				report.CachedRuns++
			} else if mayFit {
				report.AttemptedRuns++
			} else {
				reason = studioARBudget
			}
		}
		report.recordTrace(studioARRunTrace{Start: start, End: frame, Reason: reason, Accepted: accepted, Cached: usedCache})
		if !accepted {
			report.UnresolvedRuns++
			report.UnresolvedSamples += length
			report.Reasons[reason]++
			continue
		}
		report.AcceptedRuns++
		for i := range length {
			value := float32(candidate[i] * threshold)
			if math.Float32bits(value) != math.Float32bits(source[start+i]) {
				report.ChangedSamples++
			}
			output[start+i] = value
		}
	}
	return ctx.Err()
}

func studioARKnownPlateau(samples []float32, threshold float64) bool {
	sign := math.Signbit(float64(samples[0]))
	for _, sample := range samples {
		if math.Signbit(float64(sample)) != sign || math.Abs(math.Abs(float64(sample))-threshold) > threshold*1e-5 {
			return false
		}
	}
	return true
}

func prepareStudioARContext(data *studioARContextData, source []float32, boundary, direction int, threshold float64, contextFrames int, work *studioARWorkBudget) {
	data.work = work
	// Stored order always approaches the damaged boundary: left is chronological,
	// right is reversed. Both models therefore predict toward the missing run.
	data.count = min(contextFrames, boundary)
	if direction < 0 {
		data.count = min(contextFrames, len(source)-boundary)
	}
	for i := range data.count {
		if !spendStudioARWork(work, 1) {
			data.count = 0
			return
		}
		index := boundary - data.count + i
		if direction < 0 {
			index = boundary + data.count - 1 - i
		}
		value := float64(source[index])
		data.values[i], data.reliable[i] = value/threshold, math.Abs(value) < threshold
	}
	return
}

func estimateStudioARRun(ctx context.Context, source []float32, start, end int, threshold float64, contextFrames int, work *studioARWorkBudget, mayFit bool, cache *studioARModelPair) (*[studioARMaxRun]float64, bool, bool, error) {
	left, right := &work.contexts[0], &work.contexts[1]
	prepareStudioARContext(left, source, start, 1, threshold, contextFrames, work)
	prepareStudioARContext(right, source, end, -1, threshold, contextFrames, work)
	length := end - start
	sign := 1.0
	if source[start] < 0 {
		sign = -1
	}
	if cache.valid {
		forward, backward := cache.forward, cache.backward
		if validateStudioARModel(left, &forward, length) && validateStudioARModel(right, &backward, length) {
			candidate, _, ok := compareStudioARModels(left, right, forward, backward, length, sign)
			if ok {
				return candidate, true, true, nil
			}
		}
	}
	if !mayFit {
		return nil, false, false, nil
	}
	for _, order := range [6]int{2, 4, 8, 12, 24, 32} {
		if err := ctx.Err(); err != nil {
			return nil, false, false, err
		}
		forward, ok := fitStudioARModel(left, order, length)
		if !ok {
			forward, ok = fitStudioARReflection(left, order, length)
		}
		if !ok && order == 2 {
			forward, ok = fitStudioARTone(left, length)
		}
		if !ok {
			continue
		}
		backward, ok := fitStudioARModel(right, order, length)
		if !ok {
			backward, ok = fitStudioARReflection(right, order, length)
		}
		if !ok && order == 2 {
			backward, ok = fitStudioARTone(right, length)
		}
		if !ok {
			continue
		}
		candidate, _, ok := compareStudioARModels(left, right, forward, backward, length, sign)
		if ok {
			*cache = studioARModelPair{forward: forward, backward: backward, valid: true}
			return candidate, true, false, nil
		}
	}
	return nil, false, false, nil
}

func compareStudioARModels(left, right *studioARContextData, forward, backward studioARModel, length int, sign float64) (*[studioARMaxRun]float64, float64, bool) {
	// Fits have finished; their residual/matrix storage now holds prediction.
	// No caller retains these views after copying the accepted output samples.
	f := (*[studioARMaxRun]float64)(left.work.buffers[0][:studioARMaxRun])
	b := (*[studioARMaxRun]float64)(left.work.buffers[1][:studioARMaxRun])
	leftHistory, ok := forward.condition(left)
	if !ok || !forward.predict(leftHistory[:forward.order], length, f) {
		return nil, 0, false
	}
	rightHistory, ok := backward.condition(right)
	if !ok || !backward.predict(rightHistory[:backward.order], length, b) {
		return nil, 0, false
	}
	difference, correction, maxDifference := 0.0, 0.0, 0.0
	consistent := true
	for i := range length {
		if !spendStudioARWork(left.work, 12) {
			return nil, 0, false
		}
		x, y := f[i], b[length-1-i]
		weight := float64(length-i) / float64(length+1)
		f[i] = weight*x + (1-weight)*y
		delta := x - y
		difference += delta * delta
		maxDifference = math.Max(maxDifference, math.Abs(delta))
		change := f[i] - sign
		correction += change * change
		consistent = consistent && f[i]*sign >= 1 && math.Abs(f[i]) <= 3
	}
	errorEnergy := float64(length) * (forward.validationError + backward.validationError)
	if !consistent || correction < 1e-8 || difference > .04*correction || errorEnergy > .04*correction || difference > .0009*float64(length) || maxDifference > .08 {
		return nil, 0, false
	}
	return f, difference/float64(length) + forward.validationError + backward.validationError, true
}

func studioARReliableWindow(data *studioARContextData, start, end int) bool {
	if start < 0 || end > data.count || !spendStudioARWork(data.work, end-start) {
		return false
	}
	for i := start; i < end; i++ {
		if !data.reliable[i] {
			return false
		}
	}
	return true
}

func fitStudioARModel(data *studioARContextData, order, length int) (studioARModel, bool) {
	model := studioARModel{order: order, work: data.work}
	if data.count < 96 {
		return model, false
	}
	// Square-root ridge avoids squaring the condition number of correlated
	// lag columns. The fixed augmented QR system is accumulated with Givens
	// rotations; no source-sized matrix or unbounded optimizer is allocated.
	const ridge = 1e-20
	cut := data.count * 3 / 4
	dimensions, count := order+1, 0
	upper := studioARMatrix(data.work)
	if upper == nil {
		return model, false
	}
	for i := range dimensions {
		upper[(i)*(studioARMaxOrder+2)+(i)] = math.Sqrt(ridge * float64(cut))
	}
	for i := order; i < cut; i++ {
		if !studioARReliableWindow(data, i-order, i+1) {
			continue
		}
		if !spendStudioARWork(data.work, 2*dimensions*(dimensions+3)) {
			return model, false
		}
		var row [studioARMaxOrder + 2]float64
		row[0], row[dimensions] = 1, data.values[i]
		for lag := 1; lag <= order; lag++ {
			row[lag] = data.values[i-lag]
		}
		for column := range dimensions {
			radius := math.Hypot(upper[(column)*(studioARMaxOrder+2)+(column)], row[column])
			if radius == 0 {
				continue
			}
			cosine, sine := upper[(column)*(studioARMaxOrder+2)+(column)]/radius, row[column]/radius
			for cell := column; cell <= dimensions; cell++ {
				old, incoming := upper[(column)*(studioARMaxOrder+2)+(cell)], row[cell]
				upper[(column)*(studioARMaxOrder+2)+(cell)] = cosine*old + sine*incoming
				row[cell] = cosine*incoming - sine*old
			}
		}
		count++
	}
	if count < max(32, 4*dimensions) {
		return model, false
	}
	if !spendStudioARWork(data.work, dimensions*dimensions) {
		return model, false
	}
	for row := dimensions - 1; row >= 0; row-- {
		value := upper[(row)*(studioARMaxOrder+2)+(dimensions)]
		for column := row + 1; column < dimensions; column++ {
			value -= upper[(row)*(studioARMaxOrder+2)+(column)] * model.coefficients[column]
		}
		if math.Abs(upper[(row)*(studioARMaxOrder+2)+(row)]) < 1e-14 {
			return model, false
		}
		model.coefficients[row] = value / upper[(row)*(studioARMaxOrder+2)+(row)]
		if !finite(model.coefficients[row]) || math.Abs(model.coefficients[row]) > 2048 {
			return model, false
		}
	}
	ok := validateStudioARModel(data, &model, length)
	return model, ok
}

func validateStudioARModel(data *studioARContextData, model *studioARModel, length int) bool {
	order := model.order
	if data.count < 96 {
		return false
	}
	cut := data.count * 3 / 4
	energy, errorEnergy, validationCount := 0.0, 0.0, 0
	for i := cut; i < data.count; i++ {
		if !studioARReliableWindow(data, i-order, i+1) {
			continue
		}
		if !spendStudioARWork(data.work, order+2) {
			return false
		}
		prediction := model.coefficients[0]
		for lag := 1; lag <= order; lag++ {
			prediction += model.coefficients[lag] * data.values[i-lag]
		}
		delta := prediction - data.values[i]
		energy += data.values[i] * data.values[i]
		errorEnergy += delta * delta
		validationCount++
	}
	if (validationCount < 8 && !model.sparseTone) || errorEnergy > .00025*math.Max(energy, 1e-8) {
		return false
	}
	// An uninterrupted blind rollout through the withheld quarter includes
	// damaged positions as latent predictions. Only known reliable observations
	// contribute error; no teacher forcing or reset occurs across unknown ones.
	// Requiring the whole validation gap to be reliable rejects ordinary clipped
	// sines when their reliable inter-peak intervals are shorter than the damage.
	for start := max(order, cut-length); start <= data.count-length; start++ {
		if !studioARReliableWindow(data, start-order, start) {
			continue
		}
		horizon := min(max(64, length), data.count-start)
		prediction := (*[studioARMaxRun]float64)(data.work.buffers[0][:studioARMaxRun])
		if !model.predict(data.values[start-order:start], horizon, prediction) {
			return false
		}
		energy, errorEnergy, validationCount = 0, 0, 0
		for i := range horizon {
			if !spendStudioARWork(data.work, 4) {
				return false
			}
			if start+i < cut || !data.reliable[start+i] {
				continue
			}
			delta := prediction[i] - data.values[start+i]
			errorEnergy += delta * delta
			energy += data.values[start+i] * data.values[start+i]
			validationCount++
		}
		if validationCount < max(8, length/4) {
			continue
		}
		model.validationError = errorEnergy / float64(validationCount)
		return model.validationError <= .0001 && errorEnergy <= .01*math.Max(energy, 1e-8)
	}
	return false
}

func solveStudioARSystem(normal *[studioARMatrixCells]float64, dimensions int, result *[studioARMaxOrder + 1]float64) bool {
	for column := range dimensions {
		pivot := column
		for row := column + 1; row < dimensions; row++ {
			if math.Abs(normal[(row)*(studioARMaxOrder+2)+(column)]) > math.Abs(normal[(pivot)*(studioARMaxOrder+2)+(column)]) {
				pivot = row
			}
		}
		if math.Abs(normal[(pivot)*(studioARMaxOrder+2)+(column)]) < 1e-12 {
			return false
		}
		for cell := 0; cell <= dimensions; cell++ {
			a, b := column*(studioARMaxOrder+2)+cell, pivot*(studioARMaxOrder+2)+cell
			normal[a], normal[b] = normal[b], normal[a]
		}
		divisor := normal[(column)*(studioARMaxOrder+2)+(column)]
		for cell := column; cell <= dimensions; cell++ {
			normal[(column)*(studioARMaxOrder+2)+(cell)] /= divisor
		}
		for row := range dimensions {
			if row == column {
				continue
			}
			factor := normal[(row)*(studioARMaxOrder+2)+(column)]
			for cell := column; cell <= dimensions; cell++ {
				normal[(row)*(studioARMaxOrder+2)+(cell)] -= factor * normal[(column)*(studioARMaxOrder+2)+(cell)]
			}
		}
	}
	for i := range dimensions {
		result[i] = normal[(i)*(studioARMaxOrder+2)+(dimensions)]
		if !finite(result[i]) || math.Abs(result[i]) > 2048 {
			return false
		}
	}
	return true
}

func (m *studioARModel) predict(history []float64, count int, result *[studioARMaxRun]float64) bool {
	var previous [studioARMaxOrder]float64
	copy(previous[:m.order], history)
	for i := range count {
		if !spendStudioARWork(m.work, 2*m.order+4) {
			return false
		}
		value := m.coefficients[0]
		for lag := 1; lag <= m.order; lag++ {
			value += m.coefficients[lag] * previous[m.order-lag]
		}
		if !finite(value) || math.Abs(value) > 3 {
			return false
		}
		result[i] = value
		copy(previous[:m.order-1], previous[1:m.order])
		previous[m.order-1] = value
	}
	return true
}

// Missing context samples are latent model state, never training targets. Known
// reliable observations remain exact anchors. No estimate becomes evidence for
// fitting another run. This allows a validated order4 model to reach a boundary
// whose final four positions include an earlier independently clipped peak.
func (m *studioARModel) condition(data *studioARContextData) ([studioARMaxOrder]float64, bool) {
	var history [studioARMaxOrder]float64
	for end := data.count; end >= m.order; end-- {
		if !studioARReliableWindow(data, end-m.order, end) {
			continue
		}
		copy(history[:m.order], data.values[end-m.order:end])
		errorEnergy, known := 0.0, 0
		for frame := end; frame < data.count; frame++ {
			if !spendStudioARWork(data.work, 2*m.order+8) {
				return history, false
			}
			value := m.coefficients[0]
			for lag := 1; lag <= m.order; lag++ {
				value += m.coefficients[lag] * history[m.order-lag]
			}
			if !finite(value) || math.Abs(value) > 3 {
				return history, false
			}
			if data.reliable[frame] {
				delta := value - data.values[frame]
				errorEnergy += delta * delta
				known++
				value = data.values[frame]
			} else if math.Abs(data.values[frame]) > 1.00001 || value*math.Copysign(1, data.values[frame]) < 1 {
				return history, false
			}
			copy(history[:m.order-1], history[1:m.order])
			history[m.order-1] = value
		}
		return history, errorEnergy <= .0001*float64(max(1, known))
	}
	return history, false
}

func (r *studioARChannelReport) recordTrace(trace studioARRunTrace) {
	if r.TraceCount < len(r.Trace) {
		r.Trace[r.TraceCount] = trace
		r.TraceCount++
	} else {
		r.OmittedTrace++
	}
}

// Work units conservatively charge scalar inner updates before execution.
// Charges include reliability scans, context copying, fitting, prediction and
// every cache validation. Exhaustion never accepts an unvalidated candidate.
// No wall-clock guarantee follows; native/WASM cost must be measured separately.
type studioARWorkBudget struct {
	ctx       context.Context
	remaining int64
	sincePoll int
	exhausted bool
	err       error
	contexts  [2]studioARContextData
	buffers   [2][studioARContext]float64
	missing   [studioARContext + 1]uint16
}

func spendStudioARWork(work *studioARWorkBudget, units int) bool {
	if work == nil {
		return true
	}
	if work.err != nil || work.exhausted {
		return false
	}
	if units < 0 || int64(units) > work.remaining {
		work.exhausted = true
		return false
	}
	work.remaining -= int64(units)
	work.sincePoll += units
	if work.sincePoll >= 128 {
		work.sincePoll = 0
		work.err = work.ctx.Err()
	}
	return work.err == nil
}

// The same 64 KiB fit buffer is reused for QR/Gaussian matrices and reflection
// residuals. These fits never run concurrently. No unsafe memory view is used.
func studioARMatrix(work *studioARWorkBudget) *[studioARMatrixCells]float64 {
	if work == nil {
		return new([studioARMatrixCells]float64)
	}
	if !spendStudioARWork(work, studioARMatrixCells) {
		return nil
	}
	matrix := (*[studioARMatrixCells]float64)(work.buffers[0][:studioARMatrixCells])
	clear(matrix[:])
	return matrix
}
