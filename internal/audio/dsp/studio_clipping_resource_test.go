package dsp

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
)

type studioARCancelAfterChecks struct {
	context.Context
	checks, limit int
}

func (c *studioARCancelAfterChecks) Err() error {
	c.checks++
	if c.checks >= c.limit {
		return context.Canceled
	}
	return nil
}

func TestStudioARRepairAdmissionAndCancellationReturnNoPartialAudio(t *testing.T) {
	valid := []float32{0, .2, 0}
	type layout struct {
		ctx             context.Context
		rate, threshold float64
		left, right     []float32
	}
	cases := []layout{
		{nil, 48000, .7, valid, valid},
		{context.Background(), math.NaN(), .7, valid, valid},
		{context.Background(), 7999, .7, valid, valid},
		{context.Background(), 192001, .7, valid, valid},
		{context.Background(), 48000, math.Inf(1), valid, valid},
		{context.Background(), 48000, 0, valid, valid},
		{context.Background(), 48000, 4.1, valid, valid},
		{context.Background(), 48000, .7, nil, nil},
		{context.Background(), 48000, .7, valid, valid[:1]},
		{context.Background(), 48000, .7, []float32{float32(math.NaN())}, []float32{0}},
		{context.Background(), 48000, .7, []float32{0}, []float32{float32(math.Inf(-1))}},
	}
	tooLong := make([]float32, studioARMaxFrames+1)
	cases = append(cases, layout{context.Background(), 48000, .7, tooLong, tooLong})
	for i, c := range cases {
		left, right, _, err := repairStudioClippedPCM(c.ctx, c.rate, c.threshold, c.left, c.right)
		if err == nil || left != nil || right != nil {
			t.Errorf("invalid layout%d returned audio or no error", i)
		}
	}
	source := studioARHardClip(studioARQualityFixture(48000, 16384, "noise"), .7)
	for _, limit := range []int{1, 5, 20, 100} {
		ctx := &studioARCancelAfterChecks{Context: context.Background(), limit: limit}
		left, right, _, err := repairStudioClippedPCM(ctx, 48000, .7, source, source)
		if !errors.Is(err, context.Canceled) || left != nil || right != nil {
			t.Errorf("cancel after%d checks returned partial audio or wrong error:%v", limit, err)
		}
	}
}

func TestStudioARRepairCacheBudgetAndRejectionAccounting(t *testing.T) {
	for _, kind := range []string{"noise", "dc-tone"} {
		source := studioARHardClip(studioARQualityFixture(8000, 8192, kind), .7)
		output, other, report, err := repairStudioClippedPCM(context.Background(), 8000, .7, source, source)
		if err != nil {
			t.Fatal(err)
		}
		for ch, r := range report.Channels {
			if r.AttemptedRuns > studioARMaxAttempts || r.CachedRuns > r.AcceptedRuns || r.AcceptedRuns > r.CachedRuns+r.AttemptedRuns || r.DetectedRuns != r.AcceptedRuns+r.UnresolvedRuns || r.TraceCount+r.OmittedTrace != r.DetectedRuns {
				t.Errorf("channel%d invalid bounded accounting:%+v", ch, r)
			}
			reasons := 0
			for _, count := range r.Reasons {
				reasons += count
			}
			if reasons != r.UnresolvedRuns {
				t.Error("rejected-run reasons do not account for every unresolved run")
			}
			for _, trace := range r.Trace[:r.TraceCount] {
				if trace.Start < 0 || trace.End > len(source) || trace.Start >= trace.End {
					t.Fatal("invalid bounded run trace")
				}
				if !trace.Accepted {
					for i := trace.Start; i < trace.End; i++ {
						if math.Float32bits(output[i]) != math.Float32bits(source[i]) {
							t.Error("unaccepted trace changed bytes")
						}
					}
				}
			}
		}
		if report.Channels[0] != report.Channels[1] {
			t.Error("equal channel contexts produced unequal selection/accounting")
		}
		for i := range output {
			if math.Float32bits(output[i]) != math.Float32bits(other[i]) {
				t.Fatal("equal channel contexts produced unequal bytes")
			}
		}
		if kind == "noise" {
			if report.Channels[0].AttemptedRuns > studioARMaxAttempts || !report.Channels[0].WorkExhausted || report.Channels[0].WorkUnits > studioARWorkLimit || report.Channels[0].Reasons[studioARBudget] == 0 || report.Channels[0].AcceptedRuns != 0 {
				t.Error("unpredictable corpus did not exercise the independent work quota and abstention")
			}
			for i := range output {
				if math.Float32bits(output[i]) != math.Float32bits(source[i]) {
					t.Fatal("noise abstention changed bytes")
				}
			}
		} else if report.Channels[0].CachedRuns == 0 || report.Channels[0].AcceptedRuns <= studioARMaxAttempts {
			t.Error("predictable source did not exercise validated cache reuse beyond refit cap")
		}
		t.Logf("kind%s sourceSHA256%s outputSHA256%s detected%d accepted%d cached%d refits%d unresolved%d reasons%v trace%d omitted%d", kind, studioARFixtureHash(source), studioARFixtureHash(output), report.Channels[0].DetectedRuns, report.Channels[0].AcceptedRuns, report.Channels[0].CachedRuns, report.Channels[0].AttemptedRuns, report.Channels[0].UnresolvedRuns, report.Channels[0].Reasons, report.Channels[0].TraceCount, report.Channels[0].OmittedTrace)
	}
}

func TestStudioARRepairStereoIndependenceOwnershipAndMaximumAdmission(t *testing.T) {
	left := studioARHardClip(studioARQualityFixture(48000, 4096, "dc-tone"), .7)
	right := studioARHardClip(studioARQualityFixture(48000, 4096, "noise"), .7)
	leftHash, rightHash := studioARFixtureHash(left), studioARFixtureHash(right)
	a, b, mixed, err := repairStudioClippedPCM(context.Background(), 48000, .7, left, right)
	if err != nil {
		t.Fatal(err)
	}
	c, _, one, err := repairStudioClippedPCM(context.Background(), 48000, .7, left, left)
	if err != nil {
		t.Fatal(err)
	}
	_, d, two, err := repairStudioClippedPCM(context.Background(), 48000, .7, right, right)
	if err != nil {
		t.Fatal(err)
	}
	if mixed.Channels[0] != one.Channels[0] || mixed.Channels[1] != two.Channels[1] {
		t.Error("unrelated opposite channel changed fit/selection accounting")
	}
	for i := range a {
		if math.Float32bits(a[i]) != math.Float32bits(c[i]) || math.Float32bits(b[i]) != math.Float32bits(d[i]) {
			t.Fatal("opposite channel altered an independent estimate")
		}
	}
	a[0], b[0] = 123, -123
	if studioARFixtureHash(left) != leftHash || studioARFixtureHash(right) != rightHash {
		t.Fatal("source was mutated or output aliases source")
	}
	source := make([]float32, studioARMaxFrames)
	for i := range source {
		source[i] = .7
	}
	a, b, report, err := repairStudioClippedPCM(context.Background(), 192000, .7, source, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != studioARMaxFrames || len(b) != studioARMaxFrames || report.Channels[0].AttemptedRuns != 0 || report.Channels[0].Reasons[studioARLongRun] != 1 {
		t.Fatal("maximum admitted long run was not scanned once and retained")
	}
	for i := range source {
		if math.Float32bits(a[i]) != math.Float32bits(source[i]) || math.Float32bits(b[i]) != math.Float32bits(source[i]) {
			t.Fatal("maximum-source long-run abstention changed bytes")
		}
	}
}

// A tiny explicitly internal context makes every fit cheaply ineligible. This
// exercises the refit cap independently of the separate arithmetic-work quota.
func TestStudioARRepairRefitCapIndependentOfWorkQuota(t *testing.T) {
	source := make([]float32, 1024)
	for i := 1; i < len(source)-1; i += 2 {
		source[i] = .7
	}
	output := append([]float32(nil), source...)
	var work studioARWorkBudget
	var report studioARChannelReport
	if err := repairStudioARChannel(context.Background(), source, output, float64(float32(.7)), 4, 4, &work, &report); err != nil {
		t.Fatal(err)
	}
	if report.AttemptedRuns != studioARMaxAttempts || report.WorkExhausted || report.AcceptedRuns != 0 || report.Reasons[studioARBudget] == 0 {
		t.Fatalf("independent refit bound not exercised: %+v", report)
	}
	if studioARFixtureHash(source) != studioARFixtureHash(output) {
		t.Fatal("refit-limited abstention changed bytes")
	}
	t.Logf("refits%d work%d exhausted%v budget-unresolved%d", report.AttemptedRuns, report.WorkUnits, report.WorkExhausted, report.Reasons[studioARBudget])
}

func TestStudioARRepairPhysicalTimeAndScratchBounds(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		source := []float32{0, .2, 0}
		_, _, report, err := repairStudioClippedPCM(context.Background(), rate, .7, source, source)
		if err != nil {
			t.Fatal(err)
		}
		if report.ContextFrames != min(4096, max(256, int(math.Ceil(rate*.032)))) || report.MaxRunFrames != min(256, max(4, int(math.Ceil(rate*.00075)))) || report.WorkLimitPerChannel != 32_000_000 {
			t.Fatalf("unexpected private physical-time contract: %+v", report)
		}
		t.Logf("rate%.0f context%d maxrun%d", rate, report.ContextFrames, report.MaxRunFrames)
	}
	// Count the shared workspace once, both channel reports, cache, and a
	// conservative simultaneous allowance for all small model/history/row arrays.
	// This is an algorithm-data bound, not Go runtime stack/allocator overhead.
	workspace := reflect.TypeFor[studioARWorkBudget]().Size()
	scratch := workspace + reflect.TypeFor[studioARRepairReport]().Size() + reflect.TypeFor[studioARModelPair]().Size() + 8*reflect.TypeFor[studioARModel]().Size() + 6*reflect.TypeFor[[studioARMaxOrder]float64]().Size() + 2*reflect.TypeFor[[studioARMaxOrder + 2]float64]().Size() + 2*reflect.TypeFor[[studioARMaxOrder + 1]float64]().Size()
	if scratch > 160*1024 {
		t.Fatalf("algorithm scratch accounting%d exceeds160KiB", scratch)
	}
	if 2*4*studioARMaxFrames > 8*1024*1024 {
		t.Fatal("owned stereo output exceeds8MiB admission bound")
	}
	t.Logf("shared workspace%d bytes; conservatively accounted fixed algorithm data%d bytes; max owned output%d bytes", workspace, scratch, 2*4*studioARMaxFrames)
}

func TestStudioARRepairWorkQuotaAndCancellation(t *testing.T) {
	work := studioARWorkBudget{ctx: context.Background(), remaining: 32}
	if !spendStudioARWork(&work, 16) || !spendStudioARWork(&work, 16) || spendStudioARWork(&work, 1) || !work.exhausted || work.remaining != 0 {
		t.Fatal("work quota did not stop before the first over-budget update")
	}
	ctx := &studioARCancelAfterChecks{Context: context.Background(), limit: 1}
	work.ctx, work.remaining, work.sincePoll, work.exhausted, work.err = ctx, 1024, 0, false, nil
	if !spendStudioARWork(&work, 127) || spendStudioARWork(&work, 1) || !errors.Is(work.err, context.Canceled) || work.remaining != 896 {
		t.Fatal("counted-work cancellation did not poll at128 units")
	}
}
