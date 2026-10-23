package dsp

import "errors"

// This separately named private constructor keeps the direct audible graph
// intact. Its detector availability adds 127 frames to every aligned path,
// including disabled stages, all-off identity, Bypass and Original. The returned
// final finite record still contains exactly N samples after declared trimming.
// No Engine/capability/ABI selects it, and no ideal-sinc ceiling is certified.
func prepareStudioPartitionedAudibleGraph(rate float64, params Params, frames int64, repeat bool) (*studioGraph, error) {
	g, err := prepareStudioAudibleGraph(rate, params, frames, repeat)
	if err != nil {
		return nil, err
	}
	g.partitionedGuard = prepareStudioPartitionedPostGuardPath(&g.guard)
	g.latency = g.preGuardLatency + g.guard.latency
	if g.latency >= studioGraphDelayCapacity || g.guard.latency >= studioPostGuardLimiterCapacity {
		return nil, errors.New("private partitioned graph exceeds fixed delay capacity")
	}
	return g, nil
}
