package dsp

import (
	"math"
	"testing"
)

// tone returns a stereo 1 kHz sine whose BS.1770 loudness equals levelLUFS
// (EBU Tech 3341/3342 "dBFS" test-signal convention).
func tone(rate, levelLUFS, seconds float64) []float32 {
	out := make([]float32, int(rate*seconds))
	amp := math.Pow(10, levelLUFS/20)
	for i := range out {
		out[i] = float32(amp * math.Sin(2*math.Pi*1000*float64(i)/rate))
	}
	return out
}

func meterBlocks(m *LoudnessMeter, x []float32) {
	for start := 0; start < len(x); start += 128 {
		end := min(start+128, len(x))
		m.Process(x[start:end], x[start:end])
	}
}

func TestLiveMeterSteadyToneMatchesEBU3341(t *testing.T) {
	for _, rate := range []float64{44100, 48000, 96000, 192000} {
		m := NewLoudnessMeter(rate)
		meterBlocks(m, tone(rate, -23, 20))
		s := m.Snapshot()
		for name, got := range map[string]float64{"momentary": s.MomentaryLUFS, "short-term": s.ShortTermLUFS, "integrated": s.IntegratedLUFS} {
			if math.Abs(got+23) > 0.1 {
				t.Fatalf("%g Hz %s = %.3f LUFS, want -23 ±0.1", rate, name, got)
			}
		}
		if s.RangeLU < 0 || s.RangeLU > 0.1 {
			t.Fatalf("%g Hz steady-tone LRA = %.3f, want 0", rate, s.RangeLU)
		}
	}
}

func TestLiveMeterGatingMatchesOfflineMeter(t *testing.T) {
	// EBU Tech 3341 case 4: -36 / -23 / -36 dBFS for 10 / 60 / 10 s → -23.0 LUFS.
	x := append(append(tone(48000, -36, 10), tone(48000, -23, 60)...), tone(48000, -36, 10)...)
	m := NewLoudnessMeter(48000)
	meterBlocks(m, x)
	live := m.Snapshot().IntegratedLUFS
	offline := MeasureStereo(x, x, 48000).IntegratedLUFS
	if math.Abs(live+23) > 0.1 || math.Abs(live-offline) > 0.1 {
		t.Fatalf("integrated live %.3f, offline %.3f, want -23 ±0.1", live, offline)
	}
}

func TestLiveMeterLoudnessRangeEBU3342(t *testing.T) {
	cases := []struct {
		levels []float64
		want   float64
	}{
		{[]float64{-20, -30}, 10},
		{[]float64{-20, -15}, 5},
		{[]float64{-40, -20}, 20},
		{[]float64{-50, -35, -20, -35, -50}, 15},
	}
	for _, c := range cases {
		var x []float32
		for _, level := range c.levels {
			x = append(x, tone(48000, level, 20)...)
		}
		m := NewLoudnessMeter(48000)
		meterBlocks(m, x)
		if got := m.Snapshot().RangeLU; math.Abs(got-c.want) > 1 {
			t.Fatalf("levels %v: LRA %.2f, want %.0f ±1 (EBU Tech 3342)", c.levels, got, c.want)
		}
	}
}

func TestLiveMeterWindowsAndPeaks(t *testing.T) {
	m := NewLoudnessMeter(48000)
	if s := m.Snapshot(); s.MomentaryLUFS != NoReading || s.ShortTermLUFS != NoReading || s.IntegratedLUFS != NoReading || s.RangeLU != NoReading {
		t.Fatalf("empty meter reported readings: %+v", s)
	}
	meterBlocks(m, tone(48000, -23, 1))
	if s := m.Snapshot(); s.MomentaryLUFS == NoReading || s.ShortTermLUFS != NoReading {
		t.Fatalf("after 1 s want momentary only: %+v", s)
	}
	// fs/4 at 45° has sample peaks 3.01 dB below its true peak.
	x := make([]float32, 4800)
	for i := range x {
		x[i] = float32(0.5 * math.Sin(math.Pi/2*float64(i)+math.Pi/4))
	}
	m.Reset()
	meterBlocks(m, x)
	s := m.Snapshot()
	want := 20 * math.Log10(0.5)
	if math.Abs(s.TruePeakDBTP-want) > 0.2 || math.Abs(s.RecentPeakDBTP-want) > 0.2 {
		t.Fatalf("true peak %.2f / recent %.2f, want %.2f ±0.2", s.TruePeakDBTP, s.RecentPeakDBTP, want)
	}
	if again := m.Snapshot(); again.RecentPeakDBTP > -200 || again.TruePeakDBTP != s.TruePeakDBTP {
		t.Fatalf("recent peak must restart while the hold persists: %+v", again)
	}
}

func TestLiveMeterProcessDoesNotAllocate(t *testing.T) {
	m := NewLoudnessMeter(48000)
	x := tone(48000, -23, 0.01)[:128]
	if n := testing.AllocsPerRun(100, func() { m.Process(x, x); m.Snapshot() }); n != 0 {
		t.Fatalf("Process/Snapshot allocated %.0f times", n)
	}
}
