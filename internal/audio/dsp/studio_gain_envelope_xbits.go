package dsp

import "math"

// boundXBits is an unselected private query-path experiment. A chunk has exactly
// 2048 leaves: at each depth, the next bit of its nonnegative leaf index chooses
// the same child as the original low/high midpoint comparison. Node visitation,
// epoch breaks, float expressions and math.Max calls remain in the same order.
// The original bound method is retained unchanged as an independent control.
func (e *studioGainEnvelope) boundXBits(frame int64) float64 {
	if frame < 0 {
		// Render clocks are nonnegative; preserve the old routine's defensive
		// behavior for negative diagnostic clocks rather than changing it.
		return e.bound(frame)
	}
	epoch := frame / studioEnvelopeChunk
	tree := int(epoch & 1)
	x := int(frame % studioEnvelopeChunk)
	index, damage := 1, 0.0
	for bit := studioEnvelopeChunk / 2; ; bit >>= 1 {
		n := &e.trees[tree][index]
		if n.epoch != epoch {
			break
		}
		damage = math.Max(damage, n.slope*float64(x)+n.offset)
		if bit == 0 {
			break
		}
		index *= 2
		if x&bit != 0 {
			index++
		}
	}
	return math.Max(0, 1-damage)
}
