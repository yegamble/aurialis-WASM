package dsp

import (
	"math"
	"testing"
)

func studioStereoTestParams() StereoParams {
	p := DefaultParams().Stereo
	p.Enabled, p.WidthPct, p.MonoBass, p.CrossoverHz = true, 100, false, 120
	return p
}

func mustStudioStereo(t *testing.T, rate float64, params StereoParams) studioStereo {
	t.Helper()
	s, err := prepareStudioStereo(rate, params)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func studioLR4HistoryIsZero(bank studioLR4Bank) bool {
	return bank.first == ([2]svfState{}) && bank.low == ([2]svfState{}) && bank.high == ([2]svfState{})
}

func TestStudioStereoDisabledIsExactAndRetiredHistoryDoesNotReturn(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioStereoTestParams()
		p.Enabled = false
		s := mustStudioStereo(t, rate, p)
		for _, x := range []float64{.25, -.125, 1e-35, math.Copysign(0, -1)} {
			l, r := s.process(x, -x)
			if math.Float64bits(l) != math.Float64bits(x) || math.Float64bits(r) != math.Float64bits(-x) {
				t.Fatal("disabled stereo changed original samples")
			}
		}
		p.Enabled = true
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for frame := range int(rate * .1) {
			x := .3 * math.Sin(float64(frame)*.03)
			s.process(x, -x*.5)
		}
		p.Enabled = false
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range int(rate * .03) {
			s.process(0, 0)
		}
		if s.length != 0 || !studioLR4HistoryIsZero(s.active.bank) || s.next != (studioStereoPath{}) {
			t.Fatal("disabled stereo retained a retired filter history")
		}
		if l, r := s.process(1e-35, -.125); l != 1e-35 || r != -.125 {
			t.Fatal("settled stereo bypass was not exact")
		}
		p.Enabled = true
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range int(rate * .03) {
			if l, r := s.process(0, 0); l != 0 || r != 0 {
				t.Fatal("reenabling stereo replayed retired audio")
			}
		}
	}
}

func TestStudioStereoWidthZeroKeepsHistoryAndNullsLeftRight(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioStereoTestParams()
		p.CrossoverHz = 20
		reference := mustStudioStereo(t, rate, p)
		p.WidthPct = 0
		s := mustStudioStereo(t, rate, p)
		frame := 0
		for range int(rate * .1) {
			left, right := .1+.3*math.Sin(float64(frame)*.009), -.2*math.Cos(float64(frame)*.017)
			l, r := s.process(left, right)
			reference.process(left, right)
			frame++
			if l != r {
				t.Fatal("width0 did not null L/R")
			}
		}
		p.WidthPct = 100
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for i := range int(rate * .04) {
			left, right := .1+.3*math.Sin(float64(frame)*.009), -.2*math.Cos(float64(frame)*.017)
			l, r := s.process(left, right)
			wantL, wantR := reference.process(left, right)
			frame++
			if i > int(rate*.021) && (math.Abs(l-wantL) > 1e-10 || math.Abs(r-wantR) > 1e-10) {
				t.Fatal("width0 froze LR4 history before widening")
			}
		}
	}
}

func TestStudioStereoMonoBassPreservesTheMatchedMidPath(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioStereoTestParams()
		wide := mustStudioStereo(t, rate, p)
		p.MonoBass = true
		mono := mustStudioStereo(t, rate, p)
		wideSide, monoSide := 0.0, 0.0
		for frame := range int(rate * .4) {
			mid := .2 * math.Sin(2*math.Pi*1000*float64(frame)/rate)
			side := .2 * math.Sin(2*math.Pi*30*float64(frame)/rate)
			wl, wr := wide.process(mid+side, mid-side)
			ml, mr := mono.process(mid+side, mid-side)
			if math.Abs((wl+wr)-(ml+mr)) > 1e-6 {
				t.Fatal("mono-bass setting altered matched Mid all-pass")
			}
			if frame > int(rate*.2) {
				w, m := .5*(wl-wr), .5*(ml-mr)
				wideSide += w * w
				monoSide += m * m
			}
		}
		if 10*math.Log10(monoSide/wideSide) > -40 {
			t.Fatal("mono-bass side attenuation does not follow LR4 below crossover")
		}
	}
}

func TestStudioStereoRapidCompletePathEditsAreBoundedAndLatestWins(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		p := studioStereoTestParams()
		s := mustStudioStereo(t, rate, p)
		for frame := range int(rate * .05) {
			s.process(.3*math.Sin(float64(frame)*.031), -.2*math.Cos(float64(frame)*.019))
		}
		for edit := range 32 {
			p.Enabled = edit%3 != 0
			p.MonoBass = edit%2 == 0
			p.CrossoverHz = 20
			if edit%2 == 1 {
				p.CrossoverHz = 1000
			}
			p.WidthPct = float64((edit % 3) * 100)
			if err := s.setParams(p); err != nil {
				t.Fatal(err)
			}
			for frame := range 8 {
				l, r := s.process(.3*math.Sin(float64(edit*8+frame)*.031), -.2*math.Cos(float64(edit*8+frame)*.019))
				if !finite(l) || !finite(r) || math.Abs(l) > 8 || math.Abs(r) > 8 {
					t.Fatal("rapid LR4 edits escaped finite bounded complete paths")
				}
			}
		}
		for range int(rate * .06) {
			s.process(0, 0)
		}
		if s.length != 0 || s.hasPending || s.active.params != p {
			t.Fatal("latest prepared stereo target did not settle within two20ms fades")
		}
		p.Enabled = false
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		for range int(rate * .01) {
			s.process(0, 0)
		}
		p.Enabled = true
		if err := s.setParams(p); err != nil {
			t.Fatal(err)
		}
		s.resetHistory()
		if s.active.params != p || s.length != 0 || !studioLR4HistoryIsZero(s.active.bank) {
			t.Fatal("reset during pending edit failed latest settings or cleared history")
		}
		for range int(rate * .03) {
			if l, r := s.process(0, 0); l != 0 || r != 0 {
				t.Fatal("reset/rapid reenable replayed audio")
			}
		}
		before := s
		p.WidthPct = 201
		if s.setParams(p) == nil || s != before {
			t.Fatal("invalid stereo update was not atomic")
		}
	}
	s := mustStudioStereo(t, 48000, studioStereoTestParams())
	p := s.params
	p.CrossoverHz = 1000
	if err := s.setParams(p); err != nil {
		t.Fatal(err)
	}
	if allocations := testing.AllocsPerRun(100, func() {
		for range 128 {
			s.process(.2, -.1)
		}
	}); allocations != 0 {
		t.Fatal("stereo processing allocated")
	}
}

func TestStudioStereoFirstAndFinalFadeFramesDoNotSwitchAbruptly(t *testing.T) {
	for _, rate := range []float64{8000, 44100, 48000, 96000, 192000} {
		for _, edit := range []string{"off", "cutoff", "mono"} {
			p := studioStereoTestParams()
			s := mustStudioStereo(t, rate, p)
			for frame := range int(rate * .05) {
				x := .3 * math.Sin(float64(frame)*.03)
				s.process(x, -x*.5)
			}
			old := s.active
			switch edit {
			case "off":
				p.Enabled = false
			case "cutoff":
				p.CrossoverHz = 20
			case "mono":
				p.MonoBass = true
			}
			if err := s.setParams(p); err != nil {
				t.Fatal(err)
			}
			frames := int(math.Ceil(rate * .02))
			for frame := range frames {
				left, right := .2+.1*math.Sin(float64(frame)*.17), -.1*math.Cos(float64(frame)*.13)
				priorL, priorR := old.process(left, right)
				l, r := s.process(left, right)
				if frame == 0 && (math.Abs(l-priorL) > 8/float64(frames) || math.Abs(r-priorR) > 8/float64(frames)) {
					t.Fatal("first stereo edit frame switched phase/state abruptly")
				}
				if edit == "off" && frame == frames-1 && (l != left || r != right) {
					t.Fatal("final bypass transition frame was not exact dry")
				}
			}
			if s.length != 0 || s.active.params != p {
				t.Fatal("declared20ms complete-path fade did not finish")
			}
		}
	}
}
