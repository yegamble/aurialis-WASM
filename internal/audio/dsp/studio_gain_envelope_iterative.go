package dsp

const (
	studioEnvelopeTreeDepth      = 11
	studioEnvelopeScratchEntries = studioEnvelopeTreeDepth + 1
)

type studioEnvelopeRangeNode struct{ index, low, high int }

// Keep the prepared private traversal choice across source-epoch reset and
// parameter rebuild. Invalid state is explicit and reset only with that history.
func (e *studioGainEnvelope) resetHistory() {
	iterative := e.iterative
	*e = studioGainEnvelope{iterative: iterative}
}

// This loop preserves the recursive comparison, arithmetic and tie order. Only
// the selected child continues, so valid tree depth bounds it to 12 iterations.
func (e *studioGainEnvelope) insertLineIterative(tree, index, low, high int, epoch int64, slope, offset float64) {
	for {
		n := e.node(tree, index, epoch)
		first, last := slope*float64(low)+offset, slope*float64(high)+offset
		oldFirst, oldLast := n.slope*float64(low)+n.offset, n.slope*float64(high)+n.offset
		if first <= oldFirst && last <= oldLast {
			return
		}
		if first >= oldFirst && last >= oldLast {
			n.slope, n.offset = slope, offset
			return
		}
		mid := (low + high) / 2
		leftBetter := slope*float64(low)+offset > n.slope*float64(low)+n.offset
		midBetter := slope*float64(mid)+offset > n.slope*float64(mid)+n.offset
		if midBetter {
			n.slope, slope = slope, n.slope
			n.offset, offset = offset, n.offset
		}
		if low == high {
			return
		}
		if leftBetter != midBetter {
			index, high = index*2, mid
		} else {
			index, low = index*2+1, mid+1
		}
	}
}

// The root has 2048=2^11 leaves. Every split halves its interval, hence depth<=11.
// A left-first DFS retains at most one right sibling per depth plus its current
// node: at most 12 entries. Right is pushed first to preserve original visitation.
// Resource/admission failures latch invalid; bound then returns the conservative
// zero gain. Qualification must reject ANY such flag, never credit muted output.
func (e *studioGainEnvelope) insertRangeIterative(tree, from, to int, epoch int64, slope, offset float64) {
	if e.invalid {
		return
	}
	if studioEnvelopeChunk != 1<<studioEnvelopeTreeDepth || tree < 0 || tree >= len(e.trees) || from < 0 || from > to || to >= studioEnvelopeChunk || !finite(slope) || !finite(offset) {
		e.invalid = true
		return
	}
	var stack [studioEnvelopeScratchEntries]studioEnvelopeRangeNode
	stack[0] = studioEnvelopeRangeNode{index: 1, low: 0, high: studioEnvelopeChunk - 1}
	count := 1
	for count > 0 {
		count--
		node := stack[count]
		e.node(tree, node.index, epoch)
		if from <= node.low && node.high <= to {
			e.insertLineIterative(tree, node.index, node.low, node.high, epoch, slope, offset)
			continue
		}
		mid := (node.low + node.high) / 2
		children := 0
		if to > mid {
			children++
		}
		if from <= mid {
			children++
		}
		if count+children > len(stack) || node.low >= node.high {
			e.invalid = true
			return
		}
		if to > mid {
			stack[count] = studioEnvelopeRangeNode{index: node.index*2 + 1, low: mid + 1, high: node.high}
			count++
		}
		if from <= mid {
			stack[count] = studioEnvelopeRangeNode{index: node.index * 2, low: node.low, high: mid}
			count++
		}
	}
}
