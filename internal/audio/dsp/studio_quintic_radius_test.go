package dsp

import (
	"math"
	"testing"
)

func TestStudioQuinticRadiusExactBudgetAndOrdinaryHeldOut(t *testing.T) {
	k, ok := prepareStudioQuinticRadius(1e-7, 63, 12)
	if !ok {
		t.Fatal("valid radius preparation rejected")
	}
	for depth, radius := range k.radii {
		if radius != float64(64+40*depth)*0x1p-53 {
			t.Fatal("radius budget differs from exact reviewed recurrence")
		}
		if depth > 0 && radius-k.radii[depth-1] != 40*studioQuinticUnit {
			t.Fatal("child radius did not account for five outward average errors")
		}
	}
	fixtures := studioQuinticOrdinaryFixtures()
	state := uint64(0x9173f2a6)
	for fixture := range 128 {
		fixtures = append(fixtures, studioQuinticSeededSample(&state, fixture))
	}
	maxGap, maxNodes, exhausted := 0.0, 0, 0
	for _, samples := range fixtures {
		result := studioAssertQuinticResult(t, k.process(samples), samples, k.nodeLimit)
		maxGap, maxNodes = math.Max(maxGap, result.upper-result.lower), max(maxNodes, result.nodes)
		if result.exhausted {
			exhausted++
		} else if studioBoundUp(result.upper-result.lower) > k.tolerance {
			t.Fatal("radius result missed declared outward normalized gap")
		}
	}
	t.Logf("ordinary23+seeded128 max gap%.9g max nodes%d exhausted%d", maxGap, maxNodes, exhausted)
}

func TestStudioQuinticRadiusNewtonCounterexampleAndQuota(t *testing.T) {
	samples := [6]float64{1.8897427999495484, 1.4546955126595549, 2.4801486049524426, 1.4546955126595549, -.04580089678925958, 2.3720786341554145}
	previous := 0.0
	for side, direction := range []float64{math.Inf(-1), math.Inf(1)} {
		changed := samples
		changed[1] = math.Nextafter(changed[1], direction)
		k, _ := prepareStudioQuinticRadius(1e-7, 63, 12)
		result := studioAssertQuinticResult(t, k.process(changed), changed, k.nodeLimit)
		t.Logf("oneULP side%d normalized bound[%.17g,%.17g] nodes%d exhausted%v", side, result.lower, result.upper, result.nodes, result.exhausted)
		if side > 0 && math.Abs(result.upper-previous) > 1e-10 {
			t.Fatal("radius retained seed discontinuity")
		}
		previous = result.upper
	}
	for _, limits := range [][2]int{{1, 0}, {3, 1}, {7, 2}, {63, 12}} {
		k, _ := prepareStudioQuinticRadius(0, limits[0], limits[1])
		result := studioAssertQuinticResult(t, k.process(samples), samples, k.nodeLimit)
		if !result.exhausted {
			t.Fatal("zero tolerance did not retain explicit rounding/quota uncertainty")
		}
		t.Logf("quota%v nodes%d splits%d gap%.9g", limits, result.nodes, result.splits, result.upper-result.lower)
	}
}

func TestStudioQuinticRadiusAdmissionStereoAndNoAllocation(t *testing.T) {
	for _, config := range []struct {
		tolerance    float64
		nodes, depth int
	}{{math.NaN(), 63, 12}, {math.Inf(1), 63, 12}, {-.1, 63, 12}, {.2, 63, 12}, {1e-7, 0, 12}, {1e-7, 64, 12}, {1e-7, 63, -1}, {1e-7, 63, 13}} {
		if _, ok := prepareStudioQuinticRadius(config.tolerance, config.nodes, config.depth); ok {
			t.Fatal("invalid radius preparation accepted")
		}
	}
	var zero studioQuinticRadius
	if zero.process([6]float64{1, 2, 3, 4, 5, 6}).valid {
		t.Fatal("unprepared radius object accepted")
	}
	k, _ := prepareStudioQuinticRadius(1e-7, 63, 12)
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if k.process([6]float64{0, 0, value, 0, 0, 0}).valid {
			t.Fatal("nonfinite input accepted")
		}
	}
	left, right := [6]float64{.3, -.1, .8, .7, 0, -.2}, [6]float64{}
	want := k.process(left)
	for range 3 {
		if !k.process(right).valid || k.process(left) != want {
			t.Fatal("opposite-channel history changed radius bound")
		}
	}
	if allocations := testing.AllocsPerRun(3, func() { k.process(left); k.process(right) }); allocations != 0 {
		t.Fatal("radius peak bound allocated")
	}
}

func TestStudioQuinticRadiusConfiguredPrecisionDiagnostics(t *testing.T) {
	testStudioQuinticConfiguredPrecision(t, true)
}

func BenchmarkStudioQuinticRadiusCallbackCosts(b *testing.B) {
	benchmarkStudioQuinticCallbackCosts(b, true)
}
