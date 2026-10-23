package dsp

import "math"

const studioEnvelopeChunk = 2048

type studioEnvelopeLine struct {
	slope, offset float64
	epoch         int64
}

// A fixed interval line envelope stores the greatest planned damage.
// Events occupy at most two adjacent chunks; epochs retire old paths lazily.
// Callers keep delay+lookahead+hold below studioEnvelopeChunk and insert events
// before querying their clock. Rebuilds must clip expired history with addActive.
type studioGainEnvelope struct {
	trees [2][2 * studioEnvelopeChunk]studioEnvelopeLine
}

func (e *studioGainEnvelope) node(tree, index int, epoch int64) *studioEnvelopeLine {
	n := &e.trees[tree][index]
	if n.epoch != epoch {
		*n = studioEnvelopeLine{epoch: epoch}
	}
	return n
}

func (e *studioGainEnvelope) insertLine(tree, index, low, high int, epoch int64, slope, offset float64) {
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
		e.insertLine(tree, index*2, low, mid, epoch, slope, offset)
	} else {
		e.insertLine(tree, index*2+1, mid+1, high, epoch, slope, offset)
	}
}

func (e *studioGainEnvelope) insertRange(tree, index, low, high, from, to int, epoch int64, slope, offset float64) {
	e.node(tree, index, epoch)
	if from <= low && high <= to {
		e.insertLine(tree, index, low, high, epoch, slope, offset)
		return
	}
	mid := (low + high) / 2
	if from <= mid {
		e.insertRange(tree, index*2, low, mid, from, to, epoch, slope, offset)
	}
	if to > mid {
		e.insertRange(tree, index*2+1, mid+1, high, from, to, epoch, slope, offset)
	}
}

func (e *studioGainEnvelope) addSegment(from, to, birth int64, slope, offset float64) {
	for from <= to {
		epoch := from / studioEnvelopeChunk
		base := epoch * studioEnvelopeChunk
		end := min(to, base+studioEnvelopeChunk-1)
		e.insertRange(int(epoch&1), 1, 0, studioEnvelopeChunk-1, int(from-base), int(end-base), epoch, slope, offset+slope*float64(base-birth))
		from = end + 1
	}
}

func (e *studioGainEnvelope) add(frame int64, delay, lookahead, hold int, required float64) {
	if required >= 1 {
		return
	}
	e.addActive(frame, frame+int64(delay), lookahead, hold, required)
}

func (e *studioGainEnvelope) addActive(now, birth int64, lookahead, hold int, required float64) {
	if required >= 1 {
		return
	}
	damage := 1 - required
	end := birth + int64(lookahead)
	if now <= end {
		e.addSegment(max(now, birth), end, birth, damage/float64(lookahead), 0)
	}
	if hold > 0 && now <= end+int64(hold) {
		e.addSegment(max(now, end), end+int64(hold), birth, 0, damage)
	}
}

func (e *studioGainEnvelope) bound(frame int64) float64 {
	epoch := frame / studioEnvelopeChunk
	tree := int(epoch & 1)
	x := int(frame % studioEnvelopeChunk)
	low, high, index, damage := 0, studioEnvelopeChunk-1, 1, 0.0
	for {
		n := &e.trees[tree][index]
		if n.epoch != epoch {
			break
		}
		damage = math.Max(damage, n.slope*float64(x)+n.offset)
		if low == high {
			break
		}
		mid := (low + high) / 2
		if x <= mid {
			high = mid
			index *= 2
		} else {
			low = mid + 1
			index = index*2 + 1
		}
	}
	return math.Max(0, 1-damage)
}
