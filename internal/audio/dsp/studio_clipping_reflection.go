package dsp

import "math"

// A forward/backward reflection fit uses only fully reliable original training
// windows. The denominator has positive regularization and every coefficient
// stays strictly inside the unit interval. Stability alone is not quality:
// held-out blind prediction and two-sided correction tests remain mandatory.
func fitStudioARReflection(data *studioARContextData, order, length int) (studioARModel, bool) {
	model := studioARModel{order: order, work: data.work}
	if data.count < 96 || data.work == nil {
		return model, false
	}
	work := data.work
	cut := data.count * 3 / 4
	forward, backward := &work.buffers[0], &work.buffers[1]
	missing := &work.missing
	missing[0] = 0
	for i := 0; i < cut; i++ {
		if !spendStudioARWork(work, 4) {
			return model, false
		}
		forward[i], backward[i] = data.values[i], data.values[i]
		missing[i+1] = missing[i]
		if !data.reliable[i] {
			missing[i+1]++
		}
	}
	var polynomial [studioARMaxOrder + 1]float64
	polynomial[0] = 1
	for stage := 1; stage <= order; stage++ {
		product, energy, count := 0.0, 0.0, 0
		for frame := stage; frame < cut; frame++ {
			if !spendStudioARWork(work, 1) {
				return model, false
			}
			if missing[frame+1] != missing[frame-stage] {
				continue
			}
			if !spendStudioARWork(work, 6) {
				return model, false
			}
			f, b := forward[frame], backward[frame-1]
			product += f * b
			energy += f*f + b*b
			count++
		}
		if count < max(32, 4*(order+1)) || energy <= 1e-12*float64(count) {
			return model, false
		}
		reflection := -2 * product / (energy + 1e-14*float64(count))
		if !finite(reflection) || math.Abs(reflection) > 1+1e-12 {
			return model, false
		}
		reflection = math.Max(-1+1e-9, math.Min(1-1e-9, reflection))
		if !spendStudioARWork(work, len(polynomial)) {
			return model, false
		}
		previous := polynomial
		for i := 1; i < stage; i++ {
			if !spendStudioARWork(work, 2) {
				return model, false
			}
			polynomial[i] = previous[i] + reflection*previous[stage-i]
		}
		polynomial[stage] = reflection
		for frame := cut - 1; frame >= stage; frame-- {
			if !spendStudioARWork(work, 1) {
				return model, false
			}
			if missing[frame+1] != missing[frame-stage] {
				continue
			}
			if !spendStudioARWork(work, 4) {
				return model, false
			}
			f, b := forward[frame], backward[frame-1]
			forward[frame], backward[frame] = f+reflection*b, b+reflection*f
		}
	}
	for lag := 1; lag <= order; lag++ {
		model.coefficients[lag] = -polynomial[lag]
		if !finite(model.coefficients[lag]) || math.Abs(model.coefficients[lag]) > 2048 {
			return model, false
		}
	}
	count, offset := 0, 0.0
	for frame := order; frame < cut; frame++ {
		if !studioARReliableWindow(data, frame-order, frame+1) {
			continue
		}
		if !spendStudioARWork(work, order+2) {
			return model, false
		}
		residual := data.values[frame]
		for lag := 1; lag <= order; lag++ {
			residual -= model.coefficients[lag] * data.values[frame-lag]
		}
		offset += residual
		count++
	}
	if count == 0 {
		return model, false
	}
	model.coefficients[0] = offset / float64(count)
	ok := validateStudioARModel(data, &model, length)
	return model, ok
}
