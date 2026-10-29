package steminfer

// cspell:words steminfer ulps sgemm Roundoff

import (
	"context"
	"math"
	"runtime"
	"slices"
	"testing"
)

// These tests need no model: random block weights drive the same transformer
// code, so CI exercises frequency-axis batching on every run.

type testRandom uint32

func (seed *testRandom) next() float32 {
	*seed = *seed*1664525 + 1013904223
	return float32(*seed>>8)/(1<<24) - .5
}
func (seed *testRandom) fill(count int, scale, offset float32) []float32 {
	values := make([]float32, count)
	for i := range values {
		values[i] = offset + scale*seed.next()
	}
	return values
}

// randomBlockWeights scales each matrix near 1/sqrt(inputs) so activations
// stay in a realistic range through both residual branches.
func randomBlockWeights(seed testRandom) blockWeights {
	return blockWeights{
		rotary:    seed.fill(attentionHeadDimension/2, .1, 0),
		gamma:     seed.fill(modelDimension, .5, 1),
		qkv:       seed.fill(3*attentionInner*modelDimension, .2, 0),
		gates:     seed.fill(attentionHeads*modelDimension, .2, 0),
		gatesBias: seed.fill(attentionHeads, .5, 0),
		out:       seed.fill(modelDimension*attentionInner, .15, 0),
		ffGamma:   seed.fill(modelDimension, .5, 1),
		ffOne:     seed.fill(transformerHidden*modelDimension, .2, 0),
		ffOneBias: seed.fill(transformerHidden, .2, 0),
		ffTwo:     seed.fill(modelDimension*transformerHidden, .1, 0),
		ffTwoBias: seed.fill(modelDimension, .2, 0),
	}
}

// testRotations fills sine/cosine pairs the way loadBlock does.
func testRotations(rotary []float32, rows int) []float32 {
	rotations := make([]float32, rows*attentionHeadDimension)
	for row := range rows {
		for pair, frequency := range rotary {
			sine, cosine := math.Sincos(float64(float32(row) * frequency))
			rotations[row*64+pair*2] = float32(sine)
			rotations[row*64+pair*2+1] = float32(cosine)
		}
	}
	return rotations
}

// assertBatchMatches preserves the strict ULP contract except on Intel
// Accelerate, whose SGEMM reduction changes with row count. Its unit-scale
// fixtures use an independently checked absolute and normalized RMS budget.
// See TestIntelBatchNumericsDiagnostics: the float64 reference is invariant
// across grouping and each SGEMM satisfies its forward rounding bound.
func assertBatchMatches(t *testing.T, label string, got, want []float32) {
	t.Helper()
	if runtime.GOOS == "darwin" && runtime.GOARCH == "amd64" && matrixBackendName() == "apple-accelerate" {
		assertIntelBatchRoundoff(t, label, got, want)
		return
	}
	tolerance := 1.0
	if matrixBackendName() == "portable-go" {
		tolerance = 0
	}
	assertWithinUlps(t, label, got, want, tolerance)
}

const float32Precision = 1.0 / (1 << 23)

// intelBatchErrors returns infinities for invalid geometry or nonfinite data.
// A zero reference requires exact zero output, so relative RMS is well defined.
func intelBatchErrors(got, want []float32) (maximum, relativeRMS float64) {
	if len(got) != len(want) || len(want) == 0 {
		return math.Inf(1), math.Inf(1)
	}
	var errorEnergy, signalEnergy float64
	for i, expected := range want {
		if !finite32(got[i]) || !finite32(expected) {
			return math.Inf(1), math.Inf(1)
		}
		difference := float64(got[i]) - float64(expected)
		maximum = math.Max(maximum, math.Abs(difference))
		errorEnergy += difference * difference
		signalEnergy += float64(expected) * float64(expected)
	}
	if signalEnergy == 0 {
		if errorEnergy != 0 {
			return maximum, math.Inf(1)
		}
		return maximum, 0
	}
	return maximum, math.Sqrt(errorEnergy / signalEnergy)
}

func assertIntelBatchRoundoff(t *testing.T, label string, got, want []float32) {
	t.Helper()
	maximum, relativeRMS := intelBatchErrors(got, want)
	// Both limits apply: a localized error cannot hide in the RMS, and many
	// small errors cannot hide below the absolute cap. These are >52x tighter
	// in absolute error and >40 dB stricter than the full-model quality gate.
	if maximum > 16*float32Precision || relativeRMS > 8*float32Precision {
		t.Fatalf("%s: Intel SGEMM maxAbs=%g (limit %g), normalizedRMS=%g (limit %g)", label, maximum, 16*float32Precision, relativeRMS, 8*float32Precision)
	}
}

func TestIntelBatchRoundoffBudget(t *testing.T) {
	for _, test := range []struct {
		name      string
		got, want []float32
		accepted  bool
	}{
		{"exact zero", []float32{0}, []float32{0}, true},
		{"small rounding", []float32{1 + 4*float32Precision}, []float32{1}, true},
		{"absolute cap", []float32{8 + 24*float32Precision}, []float32{8}, false},
		{"RMS cap", []float32{.125 + 2*float32Precision}, []float32{.125}, false},
		{"zero reference", []float32{math.SmallestNonzeroFloat32}, []float32{0}, false},
		{"shape", []float32{0}, []float32{}, false},
		{"empty", nil, nil, false},
		{"NaN", []float32{float32(math.NaN())}, []float32{0}, false},
		{"infinite reference", []float32{0}, []float32{float32(math.Inf(1))}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			maximum, relativeRMS := intelBatchErrors(test.got, test.want)
			accepted := maximum <= 16*float32Precision && relativeRMS <= 8*float32Precision
			if accepted != test.accepted {
				t.Fatalf("accepted=%v want %v: maxAbs=%g normalizedRMS=%g", accepted, test.accepted, maximum, relativeRMS)
			}
		})
	}
}

// assertWithinUlps fails when got and want differ by more than ulps units of
// float32 precision at want's magnitude.
func assertWithinUlps(t *testing.T, label string, got, want []float32, ulps float64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: length %d want %d", label, len(got), len(want))
	}
	for i := range want {
		if !finite32(got[i]) || !finite32(want[i]) {
			t.Fatalf("%s: non-finite value at %d", label, i)
		}
		unit := math.Max(float64(math.Nextafter32(float32(math.Abs(float64(want[i]))), math.MaxFloat32))-math.Abs(float64(want[i])), math.SmallestNonzeroFloat32)
		if distance := math.Abs(float64(got[i]) - float64(want[i])); distance > ulps*unit {
			t.Fatalf("%s: index %d got %g want %g (%.1f ulp, allowed %.0f)", label, i, got[i], want[i], distance/unit, ulps)
		}
	}
}

func TestBatchedTransformerMatchesSingleSequences(t *testing.T) {
	// A short sequence keeps this cheap under -race on the portable backend;
	// batching only changes how many rows share each projection.
	const sequence, capacity = 13, 3
	weights := randomBlockWeights(11)
	rotations := testRotations(weights.rotary, sequence)
	seed := testRandom(23)
	lane := newTransformerLane(capacity * sequence)
	single := newTransformerLane(sequence)
	// groups == capacity fills the lane; the shorter run on the same lane is a
	// final partial batch over stale scratch from the full one.
	for _, groups := range []int{capacity, capacity - 1} {
		input := seed.fill(groups*sequence*modelDimension, 2, 0)
		batched := slices.Clone(input)
		if err := lane.transformer(context.Background(), rotations, batched, sequence, groups, weights); err != nil {
			t.Fatal(err)
		}
		if slices.Equal(batched, input) {
			t.Fatal("transformer left its input unchanged")
		}
		for group := range groups {
			rows := input[group*sequence*modelDimension : (group+1)*sequence*modelDimension]
			alone := slices.Clone(rows)
			if err := single.transformer(context.Background(), rotations, alone, sequence, 1, weights); err != nil {
				t.Fatal(err)
			}
			assertBatchMatches(t, "batched group", batched[group*sequence*modelDimension:(group+1)*sequence*modelDimension], alone)
		}
	}
}

func TestFrequencyAxisBatchesAndLanesMatchSerial(t *testing.T) {
	// A full window needs 124 frames before a lane holds two 62-band
	// sequences. Resizing the lanes reaches the same batched path, including
	// a final partial batch, with a three-frame window.
	const frames = 3
	bands := len(bandBins)
	weights := randomBlockWeights(31)
	rotations := testRotations(weights.rotary, bands)
	seed := testRandom(37)
	hidden := seed.fill(bands*frames*modelDimension, 2, 0)
	run := func(lanes, perBatch int) []float32 {
		work := newNetworkWorkspace((frames-1)*fftHop, lanes)
		if work.frames != frames {
			t.Fatalf("workspace has %d frames, want %d", work.frames, frames)
		}
		work.laneRows = perBatch * bands
		for i := range work.lanes {
			work.lanes[i] = newTransformerLane(work.laneRows)
		}
		copy(work.rotations, rotations)
		copy(work.hidden, hidden)
		if err := work.frequencyAxis(context.Background(), weights); err != nil {
			t.Fatal(err)
		}
		return work.hidden
	}
	unbatched := run(1, 1)
	serial := run(1, 2) // batches of 2 and 1 frames
	parallel := run(6, 2)
	if !slices.Equal(serial, parallel) {
		t.Fatal("frequency axis differs between one and six lanes")
	}
	assertBatchMatches(t, "batched frequency axis", serial, unbatched)
}
