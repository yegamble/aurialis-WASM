package dsp

import (
	"fmt"
	"math"
	"math/big"
	"testing"
)

// Independent exact Lagrange POWER coefficients; no production matrix,
// interval arithmetic, Bernstein controls or heuristic Newton search is used.
func studioOracleQuinticBasis() [6][6]*big.Rat {
	var basis [6][6]*big.Rat
	for i := range basis {
		var p [6]*big.Rat
		for j := range p {
			p[j] = new(big.Rat)
		}
		p[0].SetInt64(1)
		degree := 0
		for j := 0; j < 6; j++ {
			if i == j {
				continue
			}
			var next [6]*big.Rat
			for k := range next {
				next[k] = new(big.Rat)
			}
			for k := 0; k <= degree; k++ {
				term := new(big.Rat).Quo(p[k], big.NewRat(int64(i-j), 1))
				next[k].Sub(next[k], new(big.Rat).Mul(term, big.NewRat(int64(j-2), 1)))
				next[k+1].Add(next[k+1], term)
			}
			p, degree = next, degree+1
		}
		basis[i] = p
	}
	return basis
}

func studioOracleChoose(n, k int) int64 {
	result := int64(1)
	for i := 1; i <= k; i++ {
		result = result * int64(n-i+1) / int64(i)
	}
	return result
}

func TestStudioQuinticExactRationalMatrixAndPrimitiveEnclosures(t *testing.T) {
	k, ok := prepareStudioQuinticBound(1e-7, 63, 12)
	if !ok {
		t.Fatal("valid bound preparation rejected")
	}
	basis := studioOracleQuinticBasis()
	for row := range k.weights {
		norm := new(big.Rat)
		for column, interval := range k.weights[row] {
			exact := new(big.Rat)
			for power := 0; power <= row; power++ {
				term := new(big.Rat).Mul(basis[column][power], big.NewRat(studioOracleChoose(row, power), studioOracleChoose(5, power)))
				exact.Add(exact, term)
			}
			absolute := new(big.Rat).Abs(exact)
			if absolute.Cmp(big.NewRat(1, 1)) > 0 {
				t.Fatal("exact coefficient magnitude exceeds1")
			}
			norm.Add(norm, absolute)
			stored := studioQuinticRationals[row][column]
			if exact.Cmp(big.NewRat(stored[0], stored[1])) != 0 || new(big.Rat).SetFloat64(interval.low).Cmp(exact) > 0 || new(big.Rat).SetFloat64(interval.high).Cmp(exact) < 0 {
				t.Fatalf("row%d column%d failed exact rational enclosure", row, column)
			}
		}
		if norm.Cmp(big.NewRat(59, 40)) > 0 {
			t.Fatal("exact matrix row norm exceeds59/40")
		}
	}
	for _, pair := range [][2]float64{{1, .3}, {-1, .3}, {1e-300, 1e-20}, {math.SmallestNonzeroFloat64, math.SmallestNonzeroFloat64}, {-math.SmallestNonzeroFloat64, 0}, {1, -1}} {
		a, b := studioBoundInterval{pair[0], pair[0]}, studioBoundInterval{pair[1], pair[1]}
		product := new(big.Rat).Mul(new(big.Rat).SetFloat64(pair[0]), new(big.Rat).SetFloat64(pair[1]))
		average := new(big.Rat).Quo(new(big.Rat).Add(new(big.Rat).SetFloat64(pair[0]), new(big.Rat).SetFloat64(pair[1])), big.NewRat(2, 1))
		for _, test := range []struct {
			got   studioBoundInterval
			exact *big.Rat
		}{{studioBoundProduct(a, b), product}, {studioBoundAverage(a, b), average}} {
			if new(big.Rat).SetFloat64(test.got.low).Cmp(test.exact) > 0 || new(big.Rat).SetFloat64(test.got.high).Cmp(test.exact) < 0 {
				t.Fatal("outward primitive did not enclose exact rational operation")
			}
		}
	}
}

func studioOracleFloat(value float64) *big.Float {
	return new(big.Float).SetPrec(256).SetFloat64(value)
}
func studioOracleEvaluate(coefficients []*big.Float, x *big.Float) *big.Float {
	value := new(big.Float).SetPrec(256)
	for i := len(coefficients) - 1; i >= 0; i-- {
		value.Mul(value, x)
		value.Add(value, coefficients[i])
	}
	return value
}

// Derivative critical points split each polynomial into monotone intervals.
// Recursive degree reduction and 100-step high-precision bisection are independent
// of the production convex hull and the legacy cubic-seeded Newton heuristic.
func studioOracleRoots(coefficients []*big.Float) []*big.Float {
	for len(coefficients) > 1 && coefficients[len(coefficients)-1].Sign() == 0 {
		coefficients = coefficients[:len(coefficients)-1]
	}
	if len(coefficients) <= 1 {
		return nil
	}
	derivative := make([]*big.Float, len(coefficients)-1)
	for i := range derivative {
		derivative[i] = new(big.Float).SetPrec(256).Mul(coefficients[i+1], studioOracleFloat(float64(i+1)))
	}
	points := append([]*big.Float{studioOracleFloat(0)}, studioOracleRoots(derivative)...)
	points = append(points, studioOracleFloat(1))
	var roots []*big.Float
	for i := 0; i < len(points)-1; i++ {
		low, high := new(big.Float).SetPrec(256).Set(points[i]), new(big.Float).SetPrec(256).Set(points[i+1])
		first, last := studioOracleEvaluate(coefficients, low), studioOracleEvaluate(coefficients, high)
		if first.Sign() == 0 {
			roots = append(roots, new(big.Float).SetPrec(256).Set(low))
		}
		if first.Sign()*last.Sign() >= 0 {
			continue
		}
		for range 100 {
			mid := new(big.Float).SetPrec(256).Add(low, high)
			mid.Quo(mid, studioOracleFloat(2))
			value := studioOracleEvaluate(coefficients, mid)
			if value.Sign() == first.Sign() {
				low = mid
			} else {
				high = mid
			}
		}
		root := new(big.Float).SetPrec(256).Add(low, high)
		root.Quo(root, studioOracleFloat(2))
		roots = append(roots, root)
	}
	return roots
}

func studioOracleQuinticMaximum(samples [6]float64, scale float64) *big.Float {
	if scale == 0 {
		return studioOracleFloat(0)
	}
	basis := studioOracleQuinticBasis()
	coefficients := make([]*big.Float, 6)
	for power := range coefficients {
		exact := new(big.Rat)
		for i, sample := range samples {
			normalized := new(big.Rat).Quo(new(big.Rat).SetFloat64(sample), new(big.Rat).SetFloat64(scale))
			exact.Add(exact, new(big.Rat).Mul(normalized, basis[i][power]))
		}
		coefficients[power] = new(big.Float).SetPrec(256).SetRat(exact)
	}
	derivative := make([]*big.Float, 5)
	for i := range derivative {
		derivative[i] = new(big.Float).SetPrec(256).Mul(coefficients[i+1], studioOracleFloat(float64(i+1)))
	}
	points := append([]*big.Float{studioOracleFloat(0), studioOracleFloat(1)}, studioOracleRoots(derivative)...)
	maximum := studioOracleFloat(0)
	for _, point := range points {
		value := studioOracleEvaluate(coefficients, point)
		value.Abs(value)
		if value.Cmp(maximum) > 0 {
			maximum = value
		}
	}
	return maximum
}

func studioAssertQuinticBound(t *testing.T, k *studioQuinticBound, samples [6]float64) studioQuinticBoundResult {
	t.Helper()
	return studioAssertQuinticResult(t, k.process(samples), samples, k.nodeLimit)
}

func studioAssertQuinticResult(t *testing.T, result studioQuinticBoundResult, samples [6]float64, nodeLimit int) studioQuinticBoundResult {
	t.Helper()
	if !result.valid || !finite(result.scale) || !finite(result.lower) || !finite(result.upper) || result.upper < result.lower || result.nodes > nodeLimit || result.splits*2+1 > max(1, result.nodes) || result.averages != 15*result.splits {
		t.Fatalf("invalid finite/quota accounting:%+v", result)
	}
	maximum := studioOracleQuinticMaximum(samples, result.scale)
	if studioOracleFloat(result.lower).Cmp(maximum) > 0 || studioOracleFloat(result.upper).Cmp(maximum) < 0 {
		t.Fatalf("bound[%.17g,%.17g] misses independent256bit/root maximum%s", result.lower, result.upper, maximum.Text('g', 30))
	}
	return result
}

func studioQuinticOrdinaryFixtures() [][6]float64 {
	fixtures := [][6]float64{{}, {.7, .7, .7, .7, .7, .7}, {1, -1, 1, -1, 1, -1}, {1, 1 + 1e-15, 1 - 1e-15, 1, 1 + 2e-15, 1 - 2e-15},
		{math.MaxFloat64, -math.MaxFloat64, math.MaxFloat64, -math.MaxFloat64, math.MaxFloat64, -math.MaxFloat64},
		{math.MaxFloat64, math.SmallestNonzeroFloat64, -math.MaxFloat64, 0, 1, -1},
		{math.SmallestNonzeroFloat64, 2 * math.SmallestNonzeroFloat64, 3 * math.SmallestNonzeroFloat64, -math.SmallestNonzeroFloat64, 0, -2 * math.SmallestNonzeroFloat64}}
	for position := range 6 {
		var impulse [6]float64
		impulse[position] = 1
		fixtures = append(fixtures, impulse)
	}
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, frequency := range []float64{1000, rate * .49} {
			var samples [6]float64
			for i := range samples {
				samples[i] = .3 + .8*math.Sin(2*math.Pi*frequency*(float64(i)-2.3)/(4*rate))
			}
			fixtures = append(fixtures, samples)
		}
	}
	return fixtures
}

func TestStudioQuinticGlobalBoundOrdinaryAndExtremeFinite(t *testing.T) {
	k, _ := prepareStudioQuinticBound(1e-7, 63, 12)
	fixtures := studioQuinticOrdinaryFixtures()
	maximumGap, maxNodes, exhausted := 0.0, 0, 0
	for i, samples := range fixtures {
		t.Run(fmt.Sprintf("case%d", i), func(t *testing.T) {
			result := studioAssertQuinticBound(t, &k, samples)
			gap := result.upper - result.lower
			maximumGap, maxNodes = math.Max(maximumGap, gap), max(maxNodes, result.nodes)
			if result.exhausted {
				exhausted++
			}
			if gap > 2e-6 {
				t.Errorf("OPEN: default normalized precision gap%.9g exceeds2e-6", gap)
			}
		})
	}
	t.Logf("fixtures%d max normalized gap%.9g max nodes%d exhausted%d", len(fixtures), maximumGap, maxNodes, exhausted)
}

func TestStudioQuinticNewtonCounterexampleAndQuota(t *testing.T) {
	samples := [6]float64{1.8897427999495484, 1.4546955126595549, 2.4801486049524426, 1.4546955126595549, -.04580089678925958, 2.3720786341554145}
	var previous studioQuinticBoundResult
	for i, direction := range []float64{math.Inf(-1), math.Inf(1)} {
		changed := samples
		changed[1] = math.Nextafter(changed[1], direction)
		k, _ := prepareStudioQuinticBound(1e-7, 63, 12)
		result := studioAssertQuinticBound(t, &k, changed)
		t.Logf("oneULP side%d conservative normalized[%.17g,%.17g] nodes%d exhausted%v", i, result.lower, result.upper, result.nodes, result.exhausted)
		if i > 0 && math.Abs(result.upper-previous.upper) > 1e-10 {
			t.Error("OPEN: conservative bound retained Newton seed discontinuity")
		}
		previous = result
	}
	for _, limits := range [][2]int{{1, 0}, {3, 1}, {7, 2}, {63, 12}} {
		k, _ := prepareStudioQuinticBound(0, limits[0], limits[1])
		result := studioAssertQuinticBound(t, &k, samples)
		if !result.exhausted {
			t.Error("zero-tolerance fixed quota should report unresolved floating uncertainty")
		}
		t.Logf("quota%v nodes%d splits%d gap%.9g", limits, result.nodes, result.splits, result.upper-result.lower)
	}
}

func TestStudioQuinticAdmissionStatelessStereoAndNoAllocation(t *testing.T) {
	for _, config := range []struct {
		tolerance    float64
		nodes, depth int
	}{{math.NaN(), 63, 12}, {math.Inf(1), 63, 12}, {-.1, 63, 12}, {.2, 63, 12}, {1e-7, 0, 12}, {1e-7, 64, 12}, {1e-7, 63, -1}, {1e-7, 63, 13}} {
		if _, ok := prepareStudioQuinticBound(config.tolerance, config.nodes, config.depth); ok {
			t.Fatal("invalid fixed resource preparation accepted")
		}
	}
	var unprepared studioQuinticBound
	if unprepared.process([6]float64{1, 2, 3, 4, 5, 6}).valid {
		t.Fatal("unprepared bound reported validity")
	}
	k, _ := prepareStudioQuinticBound(1e-7, 63, 12)
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if k.process([6]float64{0, 0, value, 0, 0, 0}).valid {
			t.Fatal("nonfinite input accepted")
		}
	}
	left, right := [6]float64{.3, -.1, .8, .7, 0, -.2}, [6]float64{0, 0, 0, 0, 0, 0}
	want := k.process(left)
	for range 3 {
		if !k.process(right).valid || k.process(left) != want {
			t.Fatal("unrelated channel/history changed stateless bound")
		}
	}
	if allocations := testing.AllocsPerRun(3, func() { k.process(left); k.process(right) }); allocations != 0 {
		t.Fatal("private peak bound allocated while processing")
	}
}

func studioQuinticSeededSample(state *uint64, fixture int) [6]float64 {
	var samples [6]float64
	for i := range samples {
		*state = *state*6364136223846793005 + 1442695040888963407
		value := 2*float64(*state>>11)/float64(uint64(1)<<53) - 1
		exponent := (fixture*173)%2001 - 1000
		if fixture >= 96 {
			exponent = (int(*state>>32) % 2001) - 1000
		}
		samples[i] = math.Ldexp(value, exponent)
	}
	return samples
}

func TestStudioQuinticSeededHeldOutBounds(t *testing.T) {
	k, _ := prepareStudioQuinticBound(1e-7, 63, 12)
	state := uint64(0x9173f2a6)
	maximumGap, exhausted := 0.0, 0
	for fixture := range 128 {
		samples := studioQuinticSeededSample(&state, fixture)
		result := studioAssertQuinticBound(t, &k, samples)
		maximumGap = math.Max(maximumGap, result.upper-result.lower)
		if result.exhausted {
			exhausted++
		} else if studioBoundUp(result.upper-result.lower) > k.tolerance {
			t.Fatal("result without exhaustion missed declared normalized tolerance")
		}
	}
	t.Logf("seed0x9173f2a6 held-out128 max normalized gap%.9g exhausted%d; exhaustion remains conservative", maximumGap, exhausted)
}

func studioQuinticCallbackFixture(rate float64, kind string) [128][2][4][6]float64 {
	var input [128][2][4][6]float64
	high := math.Min(20000, .49*rate)
	for frame := range input {
		for channel := range input[frame] {
			for phase := range input[frame][channel] {
				for sample := range input[frame][channel][phase] {
					position := (float64(4*frame+phase+sample) - 2) / 4
					x := position / rate
					value := .7 * math.Sin(2*math.Pi*1000*x+.3*float64(channel))
					switch kind {
					case "peaky":
						value = .65*math.Sin(2*math.Pi*high*x+.2) + .45*math.Cos(2*math.Pi*high*.731*x+.7*float64(channel)) + .1
					case "transient":
						position = (position - 64) / math.Max(.5, .00003*rate)
						value += 2.4 * math.Exp(-position*position/2) * math.Cos(2*math.Pi*high*x+.3)
					}
					input[frame][channel][phase][sample] = value
				}
			}
		}
	}
	return input
}

func TestStudioQuinticConfiguredPrecisionDiagnostics(t *testing.T) {
	testStudioQuinticConfiguredPrecision(t, false)
}
func testStudioQuinticConfiguredPrecision(t *testing.T, radius bool) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []string{"steady", "peaky", "transient"} {
			input := studioQuinticCallbackFixture(rate, kind)
			// Independent root-oracle probes include both sides of the hard attack.
			oracles := make(map[[3]int]*big.Float)
			for _, frame := range []int{0, 31, 63, 64, 65, 95, 127} {
				for channel := range 2 {
					for phase := range 4 {
						samples := input[frame][channel][phase]
						scale := 0.0
						for _, value := range samples {
							scale = math.Max(scale, math.Abs(value))
						}
						oracles[[3]int{frame, channel, phase}] = studioOracleQuinticMaximum(samples, scale)
					}
				}
			}
			for _, tolerance := range []float64{1e-7, 1e-5, 1e-4} {
				k, _ := prepareStudioQuinticBound(tolerance, 63, 12)
				fast, _ := prepareStudioQuinticRadius(tolerance, 63, 12)
				maxGap, maxOracleDB, maxLowerDB, exhausted, maxNodes, undefinedDB := 0.0, 0.0, 0.0, 0, 0, 0
				for frame := range input {
					for channel := range input[frame] {
						for phase, samples := range input[frame][channel] {
							result := k.process(samples)
							if radius {
								result = fast.process(samples)
							}
							maxGap, maxNodes = math.Max(maxGap, result.upper-result.lower), max(maxNodes, result.nodes)
							if result.exhausted {
								exhausted++
							}
							if result.lower > 0 {
								maxLowerDB = math.Max(maxLowerDB, 20*math.Log10(result.upper/result.lower))
							} else if result.upper > 0 {
								undefinedDB++
							}
							if oracle := oracles[[3]int{frame, channel, phase}]; oracle != nil {
								if studioOracleFloat(result.upper).Cmp(oracle) < 0 || studioOracleFloat(result.lower).Cmp(oracle) > 0 {
									t.Fatal("configured bound missed independent high-precision root oracle")
								}
								maximum, _ := oracle.Float64()
								if maximum > 0 {
									maxOracleDB = math.Max(maxOracleDB, 20*math.Log10(result.upper/maximum))
								}
							}
						}
					}
				}
				t.Logf("rate%.0f kind%s normalizedAbsTol%g calls1024 max gap%.9g oracle56-max-overestimate%.9gdB lower-bound-max-overestimate%.9gdB undefinedDB%d max nodes%d exhausted%d", rate, kind, tolerance, maxGap, maxOracleDB, maxLowerDB, undefinedDB, maxNodes, exhausted)
			}
		}
	}
}

func BenchmarkStudioQuinticCallbackCosts(b *testing.B) {
	benchmarkStudioQuinticCallbackCosts(b, false)
}
func benchmarkStudioQuinticCallbackCosts(b *testing.B, radius bool) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []string{"steady", "peaky", "transient"} {
			for _, method := range []string{"newton-before", "bound1e-7", "bound1e-5", "bound1e-4", "newton-after"} {
				b.Run(fmt.Sprintf("rate%.0f/%s/%s", rate, kind, method), func(b *testing.B) {
					input := studioQuinticCallbackFixture(rate, kind)
					tolerance := 1e-7
					switch method {
					case "bound1e-5":
						tolerance = 1e-5
					case "bound1e-4":
						tolerance = 1e-4
					}
					k, _ := prepareStudioQuinticBound(tolerance, 63, 12)
					fast, _ := prepareStudioQuinticRadius(tolerance, 63, 12)
					bound := method != "newton-before" && method != "newton-after"
					quota, nodes, maxNodes := 0, 0, 0
					if bound {
						for _, frame := range input {
							for _, channel := range frame {
								for _, samples := range channel {
									var result studioQuinticBoundResult
									if radius {
										result = fast.process(samples)
									} else {
										result = k.process(samples)
									}
									nodes += result.nodes
									maxNodes = max(maxNodes, result.nodes)
									if result.exhausted {
										quota++
									}
								}
							}
						}
					}
					process := func() {
						for frame := range input {
							for channel := range input[frame] {
								for _, samples := range input[frame][channel] {
									peak := 0.0
									if bound {
										var result studioQuinticBoundResult
										if radius {
											result = fast.process(samples)
										} else {
											result = k.process(samples)
										}
										peak = result.scale * result.upper
									} else {
										peak = studioRefinedPeak(samples[0], samples[1], samples[2], samples[3], samples[4], samples[5])
									}
									studioAudibleBenchmarkSink = peak
								}
							}
						}
					}
					for range 2 {
						process()
					}
					b.ReportAllocs()
					b.ResetTimer()
					for range b.N {
						process()
					}
					b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/1e6, "ms/128")
					b.ReportMetric(float64(nodes)/1024, "avg-nodes/call")
					b.ReportMetric(float64(maxNodes), "max-nodes/call")
					b.ReportMetric(float64(quota), "quota/1024")
				})
			}
		}
	}
}
