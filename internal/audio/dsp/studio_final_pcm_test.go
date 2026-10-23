package dsp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"testing"
)

func TestStudioFinalCoefficientBytesAndFormula(t *testing.T) {
	digest := sha256.Sum256([]byte(studioFinalCoefficientBytes))
	if len(studioFinalCoefficientBytes) != 1536*8 || hex.EncodeToString(digest[:]) != studioFinalEstimateHash {
		t.Fatal("private reconstruction coefficient contract changed")
	}
	formula := prepareStudioPostGuardKernel()
	frozen := prepareStudioFinalKernel()
	for i, value := range formula.quarter {
		if math.Abs(value-frozen.quarter[i]) > 4e-16 {
			t.Fatal("frozen quarter coefficient differs from original formula")
		}
	}
	for i, value := range formula.half {
		if math.Abs(value-frozen.half[i]) > 4e-16 {
			t.Fatal("frozen half coefficient differs from original formula")
		}
	}
}

// Direct zero-extended convolution shares neither ring state nor frozen bytes.
// It evaluates all four phases and the complete exterior support explicitly.
func studioFinalDirectFinite4x(samples []float32) float64 {
	var coefficients [4][1024]float64
	for phase := 1; phase < 4; phase++ {
		sum := 0.0
		for tap := range coefficients[phase] {
			position := float64(tap) + float64(phase)/4
			distance := position - 512
			value := math.Sin(math.Pi*distance) / (math.Pi * distance) * (.5 - .5*math.Cos(2*math.Pi*position/1024))
			coefficients[phase][tap] = value
			sum += value
		}
		for tap := range coefficients[phase] {
			coefficients[phase][tap] /= sum
		}
	}
	peak := 0.0
	for _, x := range samples {
		peak = math.Max(peak, math.Abs(float64(x)))
	}
	for frame := -512; frame < len(samples)+512; frame++ {
		for phase := 1; phase < 4; phase++ {
			value := 0.0
			for tap, coefficient := range coefficients[phase] {
				n := frame + 512 - tap
				if n >= 0 && n < len(samples) {
					value += coefficient * float64(samples[n])
				}
			}
			peak = math.Max(peak, math.Abs(value))
		}
	}
	return peak
}

func TestStudioFinalFinite4xMatchesIndependentConvolutionAndCompleteTails(t *testing.T) {
	for _, count := range []int{1, 2, 129, 2049} {
		left, right := make([]float32, count), make([]float32, count)
		for i := range left {
			left[i] = float32(.7*math.Sin(2*math.Pi*.49*float64(i)+.3) + .4*math.Cos(2*math.Pi*.173*float64(i)))
			right[i] = -.3 * left[i]
		}
		left[0] += .8
		right[count-1] -= 1.2
		got, err := measureStudioFinite4x(context.Background(), left, right)
		if err != nil {
			t.Fatal(err)
		}
		want := math.Max(studioFinalDirectFinite4x(left), studioFinalDirectFinite4x(right))
		if math.Abs(got-want) > 3e-14 {
			t.Fatalf("count%d streaming%.17g direct%.17g", count, got, want)
		}
	}
	// Adjacent first/last samples have a genuine exterior/inter-sample maximum;
	// an estimator that only returns the largest raw sample fails this oracle.
	peak, err := measureStudioFinite4x(context.Background(), []float32{1, 1}, []float32{0, 0})
	if err != nil || math.Abs(peak-4/math.Pi) > .00001 {
		t.Fatalf("adjacent-sample reconstruction peak%g error%v", peak, err)
	}
}

func TestStudioFinalPCMQuietIdentityAndOwnedOutput(t *testing.T) {
	left := []float32{0, math.Float32frombits(1 << 31), math.SmallestNonzeroFloat32, .1, -.2}
	right := append([]float32(nil), left...)
	a, b, report, err := prepareStudioFinalPCM(context.Background(), left, right, 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	if report.CorrectionDB != 0 || report.Passes != 1 || report.AfterPeak > dbToLin(-1) || report.Estimator != studioFinalEstimateName || report.CoefficientSHA256 != studioFinalEstimateHash {
		t.Fatalf("quiet PCM incorrectly changed or reported: %+v", report)
	}
	for i := range left {
		if math.Float32bits(a[i]) != math.Float32bits(left[i]) || math.Float32bits(b[i]) != math.Float32bits(right[i]) {
			t.Fatal("quiet final PCM lost bit identity")
		}
	}
	a[0], b[0] = .2, .3
	if left[0] != 0 || right[0] != 0 {
		t.Fatal("final output aliased immutable source")
	}
}

func TestStudioFinalPCMCorrectionIsMeasuredReportedAndQuantized(t *testing.T) {
	left, right := make([]float32, 2049), make([]float32, 2049)
	for i := range left {
		left[i] = float32(1.8 * math.Sin(2*math.Pi*.49*float64(i)+.4))
		right[i] = -.7 * left[i]
	}
	for _, bits := range []int{0, 16, 24} {
		a, c, report, err := prepareStudioFinalPCM(context.Background(), left, right, bits, -1)
		if err != nil {
			t.Fatal(err)
		}
		b, d, again, err := prepareStudioFinalPCM(context.Background(), left, right, bits, -1)
		if err != nil || report != again {
			t.Fatal("deterministic final verification changed between identical calls")
		}
		after, err := measureStudioFinite4x(context.Background(), a, c)
		if err != nil || report.AfterPeak != after || after > dbToLin(-1) || report.BeforePeak <= dbToLin(-1) || report.CorrectionDB >= 0 || after < .85 {
			t.Fatalf("invalid conditional correction or hidden muting: %+v error%v", report, err)
		}
		gain := dbToLin(report.CorrectionDB)
		for i := range a {
			if math.Float32bits(a[i]) != math.Float32bits(b[i]) || math.Float32bits(c[i]) != math.Float32bits(d[i]) {
				t.Fatal("repeated quantization accumulated nondeterministic noise")
			}
			if bits == 0 && (a[i] != float32(float64(left[i])*gain) || c[i] != float32(float64(right[i])*gain)) {
				t.Fatal("correction changed the waveform beyond the reported global gain")
			}
			if bits != 0 {
				scale := math.Ldexp(1, bits-1)
				if float64(a[i])*scale != math.Round(float64(a[i])*scale) || float64(c[i])*scale != math.Round(float64(c[i])*scale) {
					t.Fatal("reported final PCM is not on its requested integer grid")
				}
			}
		}
	}
	// Raw headroom is measured and reduced before an integer encoder could clip.
	a, _, report, err := prepareStudioFinalPCM(context.Background(), []float32{2}, []float32{0}, 16, -1)
	if err != nil || a[0] >= .9 || report.BeforePeak < 2 || report.CorrectionDB > -6 {
		t.Fatal("integer clipping substituted for measured correction")
	}
}

func TestStudioFinalPCMRejectsInvalidAndCanceledRecords(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		ctx         context.Context
		left, right []float32
		bits        int
		ceiling     float64
	}{{ctx, []float32{0}, []float32{0}, 0, -1}, {nil, []float32{0}, []float32{0}, 0, -1}, {context.Background(), nil, nil, 0, -1}, {context.Background(), []float32{0}, nil, 0, -1}, {context.Background(), []float32{float32(math.NaN())}, []float32{0}, 0, -1}, {context.Background(), []float32{0}, []float32{0}, 20, -1}, {context.Background(), []float32{0}, []float32{0}, 0, 1}} {
		a, b, _, err := prepareStudioFinalPCM(tc.ctx, tc.left, tc.right, tc.bits, tc.ceiling)
		if err == nil || a != nil || b != nil {
			t.Fatal("invalid or canceled final record returned certified output")
		}
	}
}
