package dsp

import "math"

const studioQuinticUnit = 0x1p-53

type studioQuinticRadiusNode struct {
	control [6]float64
	depth   int
}

// This separate private comparison bounds the SAME exact rational quintic as
// the interval reference. It does not bound ideal-sinc reconstruction, select a
// graph, or alter any audio/latency/version contract.
type studioQuinticRadius struct {
	weights               [4][6]float64
	radii                 [studioQuinticMaxDepth + 1]float64
	tolerance             float64
	nodeLimit, depthLimit int
	prepared              bool
}

func prepareStudioQuinticRadius(tolerance float64, nodes, depth int) (studioQuinticRadius, bool) {
	base, ok := prepareStudioQuinticBound(tolerance, nodes, depth)
	if !ok {
		return studioQuinticRadius{}, false
	}
	k := studioQuinticRadius{tolerance: base.tolerance, nodeLimit: base.nodeLimit, depthLimit: base.depthLimit, prepared: true}
	for row := range k.weights {
		for column, fraction := range studioQuinticRationals[row+1] {
			k.weights[row][column] = float64(fraction[0]) / float64(fraction[1])
		}
	}
	// Let u=2^-53. Exact |weight|<=1 and row L1<=59/40<1.5. Weight
	// and normalization divisions have absolute error<=u; their combined
	// effect is <8u. A dot with six products and six additions has gamma12
	// <16u and rounded row L1<2, hence error <32u. The root radius 64u
	// covers both terms plus subnormal absolute rounding error.
	// Centers remain <2. Each (a+b)/2 adds <8u error; the longest path in
	// one subdivision has five averages. Thus radius(depth)=(64+40*depth)*u.
	// These small integer multiples of u are exact binary64 constants.
	for level := range k.radii {
		k.radii[level] = float64(64+40*level) * studioQuinticUnit
	}
	return k, true
}

func splitStudioQuinticRadius(node studioQuinticRadiusNode) (studioQuinticRadiusNode, studioQuinticRadiusNode) {
	left, right := studioQuinticRadiusNode{depth: node.depth + 1}, studioQuinticRadiusNode{depth: node.depth + 1}
	row := node.control
	left.control[0], right.control[5] = row[0], row[5]
	for level := 1; level <= 5; level++ {
		for i := 0; i <= 5-level; i++ {
			row[i] = (row[i] + row[i+1]) * .5
		}
		left.control[level], right.control[5-level] = row[0], row[5-level]
	}
	return left, right
}

func (k *studioQuinticRadius) process(samples [6]float64) studioQuinticBoundResult {
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
	var normalized [6]float64
	for i, sample := range samples {
		normalized[i] = sample / result.scale
	}
	var root studioQuinticRadiusNode
	root.control[0], root.control[5] = normalized[2], normalized[3]
	for row := range k.weights {
		for column, weight := range k.weights[row] {
			root.control[row+1] += weight * normalized[column]
		}
	}
	var stack [studioQuinticMaxDepth + 1]studioQuinticRadiusNode
	stack[0] = root
	count := 1
	for count > 0 {
		count--
		node := stack[count]
		result.nodes++
		center := 0.0
		for _, control := range node.control {
			center = max(center, math.Abs(control))
		}
		radius := k.radii[node.depth]
		upper := studioBoundUp(center + radius)
		endpoints := max(math.Abs(node.control[0]), math.Abs(node.control[5]))
		lower := max(0, studioBoundDown(endpoints-radius))
		result.lower = max(result.lower, lower)
		if studioBoundUp(upper-result.lower) <= k.tolerance {
			result.upper = max(result.upper, upper)
			continue
		}
		if node.depth >= k.depthLimit || result.nodes+count+2 > k.nodeLimit {
			result.upper, result.exhausted = max(result.upper, upper), true
			continue
		}
		left, right := splitStudioQuinticRadius(node)
		stack[count], stack[count+1] = right, left
		count += 2
		result.splits++
		result.averages += 15
	}
	return result
}
