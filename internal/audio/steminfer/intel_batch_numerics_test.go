//go:build darwin && amd64 && cgo

package steminfer

// cspell:words steminfer sgemm ulps BLAS Roundoff

import (
	"context"
	"math"
	"slices"
	"testing"
)

type batchNumericalError struct {
	count                                          int
	maximum, errorEnergy, signalEnergy, maximumULP float64
}

func (metric *batchNumericalError) add(got float32, want float64) {
	difference := math.Abs(float64(got) - want)
	metric.count++
	metric.maximum = math.Max(metric.maximum, difference)
	metric.errorEnergy += difference * difference
	metric.signalEnergy += want * want
	rounded := float32(math.Abs(want))
	unit := math.Max(float64(math.Nextafter32(rounded, math.MaxFloat32))-float64(rounded), math.SmallestNonzeroFloat32)
	metric.maximumULP = math.Max(metric.maximumULP, math.Abs(float64(got)-float64(float32(want)))/unit)
}
func (metric batchNumericalError) report(t *testing.T, label string) {
	t.Helper()
	rms := math.Sqrt(metric.errorEnergy / float64(metric.count))
	snr := math.Inf(1)
	if metric.errorEnergy > 0 {
		snr = 10 * math.Log10(metric.signalEnergy/metric.errorEnergy)
	}
	t.Logf("batch-numerics label=%s values=%d maxAbs=%.9g rms=%.9g snrDB=%.6f maxULP=%.1f", label, metric.count, metric.maximum, rms, snr, metric.maximumULP)
}
func compareBatchNumerics(t *testing.T, label string, got, want []float32) {
	t.Helper()
	var metric batchNumericalError
	for i, x := range got {
		if !finite32(x) || !finite32(want[i]) {
			t.Fatalf("%s nonfinite value", label)
		}
		metric.add(x, float64(want[i]))
	}
	metric.report(t, label)
	assertIntelBatchRoundoff(t, label, got, want)
}

// referenceMatrix rounds each independently accumulated float64 dot product
// once to float32. It never calls a BLAS backend or shares its reduction tree.
func referenceMatrix(dst, left, right []float32, rows, columns, inner int, transpose bool) {
	for row := range rows {
		for column := range columns {
			var sum float64
			for k := range inner {
				offset := k*columns + column
				if transpose {
					offset = column*inner + k
				}
				sum += float64(left[row*inner+k]) * float64(right[offset])
			}
			dst[row*columns+column] = float32(sum)
		}
	}
}

func measureAppleMatrixShapes(t *testing.T) {
	t.Helper()
	for _, shape := range []struct{ sequence, groups, columns, inner int }{{13, 3, 1536, 256}, {13, 3, 256, 512}, {62, 2, 256, 1024}, {62, 2, 8, 256}} {
		rows := shape.sequence * shape.groups
		seed := testRandom(107)
		left, right := seed.fill(rows*shape.inner, 2, 0), seed.fill(shape.columns*shape.inner, .2, 0)
		batched, alone := make([]float32, rows*shape.columns), make([]float32, rows*shape.columns)
		if err := multiply(context.Background(), batched, left, right, rows, shape.columns, shape.inner, true); err != nil {
			t.Fatal(err)
		}
		for first := 0; first < rows; first += shape.sequence {
			if err := multiply(context.Background(), alone[first*shape.columns:(first+shape.sequence)*shape.columns], left[first*shape.inner:(first+shape.sequence)*shape.inner], right, shape.sequence, shape.columns, shape.inner, true); err != nil {
				t.Fatal(err)
			}
		}
		var batchReference, singleReference, pair batchNumericalError
		const unitRoundoff = 1.0 / (1 << 24)
		operations := float64(2*shape.inner) * unitRoundoff
		gamma := operations / (1 - operations)
		var worstBoundRatio float64
		for row := range rows {
			for column := range shape.columns {
				var sum, magnitude float64
				for k := range shape.inner {
					product := float64(left[row*shape.inner+k]) * float64(right[column*shape.inner+k])
					sum += product
					magnitude += math.Abs(product)
				}
				index := row*shape.columns + column
				batchReference.add(batched[index], sum)
				singleReference.add(alone[index], sum)
				pair.add(batched[index], float64(alone[index]))
				// Standard forward bound for k products and k additions in float32.
				// Float64 reference accumulation contributes far less than one float32
				// rounding; account for it explicitly instead of adjusting the bound.
				referenceRoundoff := float64(shape.inner) * math.Ldexp(1, -53)
				bound := (gamma + referenceRoundoff/(1-referenceRoundoff)) * magnitude
				for _, value := range []float32{batched[index], alone[index]} {
					if !finite32(value) {
						t.Fatal("nonfinite SGEMM result")
					}
					difference := math.Abs(float64(value) - sum)
					if difference > bound {
						t.Fatalf("SGEMM exceeds independent forward bound: error%g bound%g", difference, bound)
					}
					if bound > 0 {
						worstBoundRatio = math.Max(worstBoundRatio, difference/bound)
					}
				}
			}
		}
		t.Logf("matrix-shape sequence=%d groups=%d columns=%d inner=%d gamma=%.9g maxBoundRatio=%.9g", shape.sequence, shape.groups, shape.columns, shape.inner, gamma, worstBoundRatio)
		batchReference.report(t, "matrix-batched-vs-float64")
		singleReference.report(t, "matrix-single-vs-float64")
		pair.report(t, "matrix-batched-vs-single")
	}
}

// referenceTransformer changes only matrix accumulation to independent
// float64 dot products. It retains the native normalization/nonlinear
// contract to isolate matrix grouping from unrelated activation differences.
func referenceTransformer(t *testing.T, input, rotations []float32, sequence, groups int, w blockWeights) []float32 {
	t.Helper()
	total := sequence * groups
	result := slices.Clone(input)
	norm, qkv, gates := make([]float32, total*256), make([]float32, total*1536), make([]float32, total*8)
	inner, projected := make([]float32, total*512), make([]float32, total*256)
	normalizeRows(norm, result, w.gamma, total, 256)
	referenceMatrix(qkv, norm, w.qkv, total, 1536, 256, true)
	referenceMatrix(gates, norm, w.gates, total, 8, 256, true)
	addBias(gates, w.gatesBias, total, 8)
	query, key, value := make([]float32, sequence*64), make([]float32, sequence*64), make([]float32, sequence*64)
	scores, output := make([]float32, sequence*sequence), make([]float32, sequence*64)
	for group := range groups {
		base := group * sequence
		for head := range 8 {
			for row := range sequence {
				for pair := range 32 {
					sine, cosine := rotations[row*64+pair*2], rotations[row*64+pair*2+1]
					for source, destination := range [2][]float32{query, key} {
						offset := (base+row)*1536 + source*512 + head*64 + pair*2
						a, b := qkv[offset], qkv[offset+1]
						destination[row*64+pair*2] = a*cosine - b*sine
						destination[row*64+pair*2+1] = b*cosine + a*sine
					}
				}
				copy(value[row*64:(row+1)*64], qkv[(base+row)*1536+1024+head*64:][:64])
			}
			referenceMatrix(scores, query, key, sequence, sequence, 64, true)
			if err := attentionSoftmax(context.Background(), scores, sequence, sequence); err != nil {
				t.Fatal(err)
			}
			referenceMatrix(output, scores, value, sequence, 64, sequence, false)
			for row := range sequence {
				gate := sigmoid(gates[(base+row)*8+head])
				for column := range 64 {
					inner[(base+row)*512+head*64+column] = output[row*64+column] * gate
				}
			}
		}
	}
	referenceMatrix(projected, inner, w.out, total, 256, 512, true)
	for i := range result {
		result[i] += projected[i]
	}
	normalizeRows(norm, result, w.ffGamma, total, 256)
	hidden := make([]float32, total*1024)
	referenceMatrix(hidden, norm, w.ffOne, total, 1024, 256, true)
	addBias(hidden, w.ffOneBias, total, 1024)
	if err := applyGELU(context.Background(), hidden); err != nil {
		t.Fatal(err)
	}
	referenceMatrix(projected, hidden, w.ffTwo, total, 256, 1024, true)
	addBias(projected, w.ffTwoBias, total, 256)
	for i := range result {
		result[i] += projected[i]
	}
	return result
}

func measureAppleFrequencyLanes(t *testing.T) {
	t.Helper()
	const frames = 3
	bands := len(bandBins)
	weights := randomBlockWeights(31)
	rotations := testRotations(weights.rotary, bands)
	seed := testRandom(37)
	hidden := seed.fill(bands*frames*modelDimension, 2, 0)
	run := func(lanes, perBatch int) []float32 {
		work := newNetworkWorkspace((frames-1)*fftHop, lanes)
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
	unbatched, serial, parallel := run(1, 1), run(1, 2), run(6, 2)
	if !slices.Equal(serial, parallel) {
		t.Fatal("frequency axis differs between one and six lanes")
	}
	t.Log("frequency-axis serial-vs-parallel=bit-exact")
	compareBatchNumerics(t, "frequency-axis-batched-vs-single", serial, unbatched)
}

func TestIntelBatchNumericsDiagnostics(t *testing.T) {
	measureAppleMatrixShapes(t)
	measureAppleFrequencyLanes(t)
	for _, fixture := range []struct {
		sequence, groups      int
		weightSeed, inputSeed testRandom
	}{{13, 3, 11, 23}, {62, 2, 31, 37}} {
		sequence, groups := fixture.sequence, fixture.groups
		weights := randomBlockWeights(fixture.weightSeed)
		rotations := testRotations(weights.rotary, sequence)
		input := fixture.inputSeed.fill(sequence*groups*256, 2, 0)
		batched, alone := slices.Clone(input), make([]float32, len(input))
		lane := newTransformerLane(sequence * groups)
		if err := lane.transformer(context.Background(), rotations, batched, sequence, groups, weights); err != nil {
			t.Fatal(err)
		}
		reference := referenceTransformer(t, input, rotations, sequence, groups, weights)
		for group := range groups {
			first, last := group*sequence*256, (group+1)*sequence*256
			copy(alone[first:last], input[first:last])
			single := newTransformerLane(sequence)
			if err := single.transformer(context.Background(), rotations, alone[first:last], sequence, 1, weights); err != nil {
				t.Fatal(err)
			}
			independent := referenceTransformer(t, input[first:last], rotations, sequence, 1, weights)
			if !slices.Equal(independent, reference[first:last]) {
				t.Fatal("float64 matrix control changed with batching")
			}
		}
		t.Logf("transformer-shape sequence=%d groups=%d independent-float64-control=bit-exact", sequence, groups)
		compareBatchNumerics(t, "transformer-batched-vs-single", batched, alone)
		compareBatchNumerics(t, "transformer-batched-vs-float64", batched, reference)
		compareBatchNumerics(t, "transformer-single-vs-float64", alone, reference)
	}
}
