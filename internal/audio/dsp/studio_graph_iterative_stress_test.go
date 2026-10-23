//go:build studio_stress

package dsp

import "testing"

func TestStudioIterativeGraphFiniteNyquistFinalOutput(t *testing.T) {
	testStudioAudibleGraphFiniteNyquistFinalOutput(t, mustStudioIterativePartitionedGraph)
}
func TestStudioIterativeGraphFiniteOutputStressCorpus(t *testing.T) {
	testStudioAudibleGraphFiniteOutputStressCorpus(t, mustStudioIterativePartitionedGraph)
}
func TestStudioIterativeGraphActiveAudibleBandFinalOutput(t *testing.T) {
	testStudioGraphActiveAudibleBandFinalOutput(t, mustStudioIterativePartitionedGraph)
}
