package dsp

import "math"

// A separately validated AR2 seed handles a single periodic component when
// reliable inter-peak spans contain no complete clean AR regression triples.
// Frequency/amplitude/DC are fitted ONLY to reliable training observations.
// It is not a general spectral or noise reconstruction model. Both directions
// still undergo the same independent held-out blind prediction checks.
func fitStudioARTone(data *studioARContextData, length int) (studioARModel, bool) {
	model := studioARModel{order: 2, sparseTone: true, work: data.work}
	if data.count < 96 {
		return model, false
	}
	cut := data.count * 3 / 4
	mean := 0.0
	for _, value := range data.values[:cut] {
		if !spendStudioARWork(data.work, 2) {
			return model, false
		}
		mean += value / float64(cut)
	}
	var first, last [2]float64
	var crossings [2]int
	for i := 1; i < cut; i++ {
		if !spendStudioARWork(data.work, 8) {
			return model, false
		}
		before, after := data.values[i-1]-mean, data.values[i]-mean
		if (before < 0 && after >= 0) || (before > 0 && after <= 0) {
			direction := 0
			if after < before {
				direction = 1
			}
			time := float64(i-1) - before/(after-before)
			if crossings[direction] == 0 {
				first[direction] = time
			}
			last[direction] = time
			crossings[direction]++
		}
	}
	omega := 0.0
	for direction, count := range crossings {
		if count >= 2 {
			omega = 2 * math.Pi * float64(count-1) / (last[direction] - first[direction])
			break
		}
	}
	if omega == 0 && crossings[0] > 0 && crossings[1] > 0 {
		omega = math.Pi / math.Abs(first[0]-first[1])
	}
	if !finite(omega) || omega <= .001 || omega >= math.Pi {
		return model, false
	}
	bestError := math.Inf(1)
	var parameters [3]float64
	bestOmega := omega
	for _, factor := range [5]float64{.8, .9, 1, 1.1, 1.2} {
		trial := omega * factor
		p, loss, ok := fitStudioARToneAt(data, cut, trial)
		if ok && loss < bestError {
			parameters, bestOmega, bestError = p, trial, loss
		}
	}
	if !finite(bestError) {
		return model, false
	}
	omega = bestOmega
	for range 8 {
		normal := studioARMatrix(data.work)
		if normal == nil {
			return model, false
		}
		for i := 0; i < cut; i++ {
			if !data.reliable[i] {
				continue
			}
			if !spendStudioARWork(data.work, 128) {
				return model, false
			}
			x := float64(i) - float64(cut-1)/2
			sine, cosine := math.Sincos(omega * x)
			prediction := parameters[0] + parameters[1]*cosine + parameters[2]*sine
			features := [4]float64{1, cosine, sine, x * (-parameters[1]*sine + parameters[2]*cosine)}
			for row := range 4 {
				normal[(row)*(studioARMaxOrder+2)+(4)] += features[row] * (data.values[i] - prediction)
				for column := range 4 {
					normal[(row)*(studioARMaxOrder+2)+(column)] += features[row] * features[column]
				}
			}
		}
		for i := range 4 {
			normal[(i)*(studioARMaxOrder+2)+(i)] += math.Max(1, normal[(i)*(studioARMaxOrder+2)+(i)]) * 1e-10
		}
		var step [studioARMaxOrder + 1]float64
		if !spendStudioARWork(data.work, 128) || !solveStudioARSystem(normal, 4, &step) {
			break
		}
		delta := math.Max(-.1*omega, math.Min(.1*omega, step[3]))
		improved := false
		for range 5 {
			trial := omega + delta
			p, loss, ok := fitStudioARToneAt(data, cut, trial)
			if ok && loss < bestError {
				parameters, omega, bestError, improved = p, trial, loss, true
				break
			}
			delta *= .5
		}
		if !improved || math.Abs(delta) < 1e-12 {
			break
		}
	}
	model.coefficients[1], model.coefficients[2] = 2*math.Cos(omega), -1
	model.coefficients[0] = parameters[0] * (2 - model.coefficients[1])
	ok := validateStudioARModel(data, &model, length)
	return model, ok
}

func fitStudioARToneAt(data *studioARContextData, cut int, omega float64) ([3]float64, float64, bool) {
	var parameters [3]float64
	if omega <= .001 || omega >= math.Pi {
		return parameters, 0, false
	}
	normal := studioARMatrix(data.work)
	if normal == nil {
		return parameters, 0, false
	}
	count := 0
	for i := 0; i < cut; i++ {
		if !data.reliable[i] {
			continue
		}
		if !spendStudioARWork(data.work, 64) {
			return parameters, 0, false
		}
		sine, cosine := math.Sincos(omega * (float64(i) - float64(cut-1)/2))
		features := [3]float64{1, cosine, sine}
		for row := range 3 {
			normal[(row)*(studioARMaxOrder+2)+(3)] += features[row] * data.values[i]
			for column := range 3 {
				normal[(row)*(studioARMaxOrder+2)+(column)] += features[row] * features[column]
			}
		}
		count++
	}
	if count < 32 {
		return parameters, 0, false
	}
	for i := range 3 {
		normal[(i)*(studioARMaxOrder+2)+(i)] += float64(count) * 1e-10
	}
	var result [studioARMaxOrder + 1]float64
	if !spendStudioARWork(data.work, 54) || !solveStudioARSystem(normal, 3, &result) {
		return parameters, 0, false
	}
	copy(parameters[:], result[:3])
	loss := 0.0
	for i := 0; i < cut; i++ {
		if data.reliable[i] {
			if !spendStudioARWork(data.work, 64) {
				return parameters, 0, false
			}
			sine, cosine := math.Sincos(omega * (float64(i) - float64(cut-1)/2))
			delta := parameters[0] + parameters[1]*cosine + parameters[2]*sine - data.values[i]
			loss += delta * delta
		}
	}
	return parameters, loss / float64(count), true
}
