package dsp

import "math"

const (
	studioQuinticMaxNodes = 63
	studioQuinticMaxDepth = 12
)

type studioBoundInterval struct{ low, high float64 }

type studioQuinticNode struct {
	control [6]studioBoundInterval
	depth   int
}

// These EXACT rational coefficients map samples at t=-2,-1,0,1,2,3
// into degree-5 Bernstein controls on [0,1]. They define the same real finite
// quintic as studioRefinedPeak, independently of its heuristic root search.
var studioQuinticRationals = [6][6][2]int64{
	{{0, 1}, {0, 1}, {1, 1}, {0, 1}, {0, 1}, {0, 1}},
	{{1, 100}, {-1, 10}, {14, 15}, {1, 5}, {-1, 20}, {1, 150}},
	{{19, 1200}, {-2, 15}, {89, 120}, {7, 15}, {-5, 48}, {1, 75}},
	{{1, 75}, {-5, 48}, {7, 15}, {89, 120}, {-2, 15}, {19, 1200}},
	{{1, 150}, {-1, 20}, {1, 5}, {14, 15}, {-1, 10}, {1, 100}},
	{{0, 1}, {0, 1}, {0, 1}, {1, 1}, {0, 1}, {0, 1}},
}

// This private numerical experiment is not selected by any graph. All results
// are SCALED bounds: scale*upper encloses the real polynomial magnitude. Keeping
// the finite scale and normalized bound separate also represents true peaks
// above MaxFloat64 without returning a false finite scalar ceiling.
type studioQuinticBoundResult struct {
	scale, lower, upper     float64
	nodes, splits, averages int
	valid, exhausted        bool
}

type studioQuinticBound struct {
	weights               [6][6]studioBoundInterval
	tolerance             float64
	nodeLimit, depthLimit int
	prepared              bool
}

func prepareStudioQuinticBound(tolerance float64, nodes, depth int) (studioQuinticBound, bool) {
	if !finite(tolerance) || tolerance < 0 || tolerance > .1 || nodes < 1 || nodes > studioQuinticMaxNodes || depth < 0 || depth > studioQuinticMaxDepth {
		return studioQuinticBound{}, false
	}
	k := studioQuinticBound{tolerance: tolerance, nodeLimit: nodes, depthLimit: depth, prepared: true}
	for row := range k.weights {
		for column, fraction := range studioQuinticRationals[row] {
			if fraction[0] != 0 {
				value := float64(fraction[0]) / float64(fraction[1])
				k.weights[row][column] = studioBoundInterval{studioBoundDown(value), studioBoundUp(value)}
			}
		}
	}
	return k, true
}

// All helpers below operate on known finite bounded normalized intermediates.
// One outward step encloses each elementary correctly rounded binary64 result;
// division/normalization, coefficient products, sums and both average operations
// are enclosed separately. Subnormal arithmetic is not silently flushed away.
func studioBoundDown(value float64) float64 {
	if value == 0 {
		return -math.SmallestNonzeroFloat64
	}
	bits := math.Float64bits(value)
	if value > 0 {
		bits--
	} else {
		bits++
	}
	return math.Float64frombits(bits)
}

func studioBoundUp(value float64) float64 { return -studioBoundDown(-value) }

func studioBoundProduct(a, b studioBoundInterval) studioBoundInterval {
	first, second, third, fourth := a.low*b.low, a.low*b.high, a.high*b.low, a.high*b.high
	low, high := min(first, second, third, fourth), max(first, second, third, fourth)
	return studioBoundInterval{studioBoundDown(low), studioBoundUp(high)}
}

func studioBoundAverage(a, b studioBoundInterval) studioBoundInterval {
	low, high := studioBoundDown(a.low+b.low), studioBoundUp(a.high+b.high)
	return studioBoundInterval{studioBoundDown(low * .5), studioBoundUp(high * .5)}
}

func studioBoundAbsolute(interval studioBoundInterval) (float64, float64) {
	lower := 0.0
	if interval.low > 0 {
		lower = interval.low
	} else if interval.high < 0 {
		lower = -interval.high
	}
	return lower, max(math.Abs(interval.low), math.Abs(interval.high))
}

func splitStudioQuintic(node studioQuinticNode) (studioQuinticNode, studioQuinticNode) {
	left, right := studioQuinticNode{depth: node.depth + 1}, studioQuinticNode{depth: node.depth + 1}
	row := node.control
	left.control[0], right.control[5] = row[0], row[5]
	for level := 1; level <= 5; level++ {
		for i := 0; i <= 5-level; i++ {
			row[i] = studioBoundAverage(row[i], row[i+1])
		}
		left.control[level], right.control[5-level] = row[0], row[5-level]
	}
	return left, right
}

func (k *studioQuinticBound) process(samples [6]float64) studioQuinticBoundResult {
	var result studioQuinticBoundResult
	if k == nil || !k.prepared {
		return result
	}
	constant := true
	for _, sample := range samples {
		if !finite(sample) {
			return result
		}
		result.scale = max(result.scale, math.Abs(sample))
		constant = constant && sample == samples[0]
	}
	result.valid = true
	if result.scale == 0 {
		return result
	}
	if constant {
		result.lower, result.upper = 1, 1
		return result
	}
	var normalized [6]studioBoundInterval
	for i, sample := range samples {
		value := sample / result.scale
		normalized[i] = studioBoundInterval{studioBoundDown(value), studioBoundUp(value)}
	}
	var root studioQuinticNode
	root.control[0], root.control[5] = normalized[2], normalized[3]
	for row := 1; row <= 4; row++ {
		for column, sample := range normalized {
			product := studioBoundProduct(k.weights[row][column], sample)
			root.control[row].low = studioBoundDown(root.control[row].low + product.low)
			root.control[row].high = studioBoundUp(root.control[row].high + product.high)
		}
	}
	var stack [studioQuinticMaxDepth + 1]studioQuinticNode
	stack[0] = root
	count := 1
	for count > 0 {
		count--
		node := stack[count]
		result.nodes++
		upper := 0.0
		for i, control := range node.control {
			lower, bound := studioBoundAbsolute(control)
			upper = max(upper, bound)
			if i == 0 || i == 5 {
				result.lower = max(result.lower, lower)
			}
		}
		if studioBoundUp(upper-result.lower) <= k.tolerance {
			result.upper = max(result.upper, upper)
			continue
		}
		// Reserving both children guarantees EVERY unresolved leaf is visited
		// within the total node quota; no pending upper hull can be discarded.
		if node.depth >= k.depthLimit || result.nodes+count+2 > k.nodeLimit {
			result.upper, result.exhausted = max(result.upper, upper), true
			continue
		}
		left, right := splitStudioQuintic(node)
		stack[count], stack[count+1] = right, left
		count += 2
		result.splits++
		result.averages += 15
	}
	return result
}
