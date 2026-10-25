package steminfer

// cspell:words steminfer resampler polyphase Bessel

import (
	"context"
	"errors"
	"math"
)

const resamplePhases = 4096
const maximumSourceFrames = 16777216

// resamplePlan is a bounded, centered Kaiser-windowed sinc/polyphase converter.
// Exact integer source position is kept separately from the interpolated phase
// table. No phase accumulation or per-block clock reset is involved. Its
// centered kernel introduces no hidden output delay; edge samples reflect.
type resamplePlan struct {
	fromRate, toRate, radius int
	coefficients             []float32
}

func besselZero(x float64) float64 {
	sum, term := 1.0, 1.0
	for i := 1; i <= 32; i++ {
		term *= x * x / (4 * float64(i*i))
		sum += term
	}
	return sum
}
func newResamplePlan(ctx context.Context, fromRate, toRate int) (*resamplePlan, error) {
	if ctx == nil || fromRate < 8000 || fromRate > 192000 || toRate < 8000 || toRate > 192000 {
		return nil, errors.New("invalid bounded source rates")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	plan := &resamplePlan{fromRate: fromRate, toRate: toRate}
	if fromRate == toRate {
		return plan, nil
	}
	cutoff := .94 * math.Min(1, float64(toRate)/float64(fromRate))
	plan.radius = int(math.Ceil(32 / cutoff))
	// Arbitrary endpoint rates are allowed, so ratio24 is the hard worst case.
	// Actual model conversion always has44.1k on one side and is smaller.
	if plan.radius > 818 {
		return nil, errors.New("resampler support exceeds bound")
	}
	taps := 2 * plan.radius
	plan.coefficients = make([]float32, (resamplePhases+1)*taps)
	denominator := besselZero(8.6)
	for phase := 0; phase <= resamplePhases; phase++ {
		if phase%32 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		fraction := float64(phase) / resamplePhases
		var sum float64
		row := plan.coefficients[phase*taps : (phase+1)*taps]
		for tap := range taps {
			distance := float64(tap-plan.radius+1) - fraction
			x := cutoff * distance
			sinc := 1.0
			if x != 0 {
				sinc = math.Sin(math.Pi*x) / (math.Pi * x)
			}
			normalized := distance / float64(plan.radius)
			window := 0.0
			if math.Abs(normalized) <= 1 {
				window = besselZero(8.6*math.Sqrt(math.Max(0, 1-normalized*normalized))) / denominator
			}
			row[tap] = float32(cutoff * sinc * window)
			sum += float64(row[tap])
		}
		for tap := range row {
			row[tap] = float32(float64(row[tap]) / sum)
		}
	}
	return plan, nil
}
func repeatedReflection(index, length int) int {
	if length == 1 {
		return 0
	}
	period := 2 * (length - 1)
	index %= period
	if index < 0 {
		index += period
	}
	if index >= length {
		return period - index
	}
	return index
}
func (plan *resamplePlan) into(ctx context.Context, destination, input []float32, first int) error {
	if ctx == nil || plan == nil || len(input) < 1 || len(input) > maximumSourceFrames || first < 0 || first > maximumSourceFrames || len(destination) > maximumSourceFrames-first {
		return errors.New("invalid bounded resampling span")
	}
	// Callers may request an exact original frame count on inverse conversion.
	// A rounded-up model-rate duration may contain an extra inverse sample;
	// callers request precisely the original count instead of exporting it.
	maximum := (int64(len(input))*int64(plan.toRate) + int64(plan.fromRate) - 1) / int64(plan.fromRate)
	if int64(first)+int64(len(destination)) > maximum {
		return errors.New("resampling span exceeds source duration")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if plan.fromRate == plan.toRate {
		if first+len(destination) > len(input) {
			return errors.New("identity span exceeds source")
		}
		for i := range destination {
			if i%4096 == 0 {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
			if !finite32(input[first+i]) {
				return errors.New("non-finite resampling source")
			}
		}
		copy(destination, input[first:first+len(destination)])
		return ctx.Err()
	}
	for i := range destination {
		if i%128 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		value, err := plan.at(first+i, len(input), 0, input, nil)
		if err != nil {
			return err
		}
		destination[i] = value
	}
	return nil
}

// at reads a continuous source through the current span and its retained tail.
// Source positions remain absolute; only the storage backing them is streamed.
func (plan *resamplePlan) at(outputIndex, inputFrames, first int, current, previous []float32) (float32, error) {
	position := int64(outputIndex) * int64(plan.fromRate)
	center := int(position / int64(plan.toRate))
	if plan.fromRate == plan.toRate {
		if center >= first && center-first < len(current) {
			value := current[center-first]
			if !finite32(value) {
				return 0, errors.New("non-finite resampling source")
			}
			return value, nil
		}
		return 0, errors.New("continuous identity source unavailable")
	}
	phaseNumerator := (position % int64(plan.toRate)) * resamplePhases
	phase := int(phaseNumerator / int64(plan.toRate))
	fraction := float64(phaseNumerator%int64(plan.toRate)) / float64(plan.toRate)
	taps := 2 * plan.radius
	a, b := plan.coefficients[phase*taps:(phase+1)*taps], plan.coefficients[(phase+1)*taps:(phase+2)*taps]
	var sum float64
	for tap := range taps {
		index := repeatedReflection(center+tap-plan.radius+1, inputFrames)
		var value float32
		switch {
		case index >= first && index-first < len(current):
			value = current[index-first]
		case index < first && index >= first-len(previous):
			value = previous[index-first+len(previous)]
		default:
			return 0, errors.New("continuous resampling source unavailable")
		}
		if !finite32(value) {
			return 0, errors.New("non-finite resampling source")
		}
		coefficient := float64(a[tap]) + (float64(b[tap])-float64(a[tap]))*fraction
		sum += float64(value) * coefficient
	}
	result := float32(sum)
	if !finite32(result) {
		return 0, errors.New("resampling output exceeds finite range")
	}
	return result, nil
}
