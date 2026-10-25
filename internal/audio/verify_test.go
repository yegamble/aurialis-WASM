package audio_test

import (
	"context"
	"encoding/binary"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func synthTestMix(sampleRate int, durationSec float64) ([]float32, []float32) {
	n := int(float64(sampleRate) * durationSec)
	left := make([]float32, n)
	right := make([]float32, n)
	sr := float64(sampleRate)
	for i := 0; i < n; i++ {
		tm := float64(i) / sr
		// Sub bass 70 Hz + Vocal mid 900 Hz + Stereo guitar/air 3500 Hz + Transient click every 0.25s
		bass := 0.28 * math.Sin(2.0*math.Pi*70.0*tm)
		vocal := 0.24 * math.Sin(2.0*math.Pi*900.0*tm)
		airL := 0.16 * math.Sin(2.0*math.Pi*3500.0*tm)
		airR := 0.16 * math.Cos(2.0*math.Pi*3500.0*tm)
		var drum float64
		phaseInBeat := math.Mod(tm, 0.25)
		if phaseInBeat < 0.015 {
			drum = 0.25 * math.Exp(-phaseInBeat/0.004) * math.Sin(2.0*math.Pi*180.0*tm)
		}
		left[i] = float32(bass + vocal + airL + drum)
		right[i] = float32(bass + vocal + airR + drum)
	}
	return left, right
}

func TestAudioCDRSanitizationAndPolyglotRejection(t *testing.T) {
	l, r := synthTestMix(48000, 0.25)
	cleanWAV, err := audio.EncodeWAV(l, r, 48000, 16)
	if err != nil {
		t.Fatalf("EncodeWAV failed: %v", err)
	}

	// 1. Valid WAV passes CDR
	buf, err := audio.DecodeAndDisarm("studio_mix.wav", cleanWAV)
	if err != nil {
		t.Fatalf("DecodeAndDisarm rejected valid WAV: %v", err)
	}
	if buf.SampleRate != 48000 || buf.Frames != len(l) {
		t.Fatalf("unexpected decoded buffer metadata: %+v", buf)
	}

	// 2. Malicious filenames rejected (path traversal, CRLF, null byte, RTLO U+202E, bad extension)
	badNames := []string{
		"../../etc/passwd.wav",
		"..\\windows\\system32\\evil.wav",
		"track\r\nX-Injected: 1.wav",
		"track\x00.wav",
		"track\u202evaw.exe",
		"payload.exe",
		"document.pdf",
		"notes.txt",
	}
	for _, name := range badNames {
		if _, err := audio.DecodeAndDisarm(name, cleanWAV); !errors.Is(err, audio.ErrInvalidFilename) {
			t.Errorf("expected ErrInvalidFilename for %q, got %v", name, err)
		}
	}

	// 3. Polyglot & binary spoof payloads rejected
	polyglotCases := []struct {
		name string
		data []byte
	}{
		{"windows-pe", []byte("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00")},
		{"elf-binary", []byte("\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00")},
		{"pdf-spoof", []byte("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")},
		{"html-script", []byte("RIFF\x24\x00\x00\x00WAVE<script>alert(1)</script>")},
		{"wav-zip-polyglot", append(append([]byte{}, cleanWAV...), []byte("PK\x03\x04\x14\x00\x00\x00\x08\x00evil.sh")...)},
	}
	for _, tc := range polyglotCases {
		if _, err := audio.DecodeAndDisarm("spoof.wav", tc.data); !errors.Is(err, audio.ErrPolyglotPayload) {
			t.Errorf("case %s: expected ErrPolyglotPayload, got %v", tc.name, err)
		}
	}

	// 4. Corrupt RIFF / 0xFFFFFFFF chunk overflow rejected without panic
	corruptOverflow := append([]byte{}, cleanWAV[:44]...)
	binary.LittleEndian.PutUint32(corruptOverflow[40:44], 0xFFFFFFFF)
	if _, err := audio.DecodeAndDisarm("overflow.wav", corruptOverflow); !errors.Is(err, audio.ErrCorruptContainer) {
		t.Errorf("expected ErrCorruptContainer on 0xFFFFFFFF data size, got %v", err)
	}

	// 5. WAV with non-audio JUNK/LIST metadata chunk has metadata stripped upon re-encode
	withJunk := make([]byte, 0, len(cleanWAV)+24)
	withJunk = append(withJunk, cleanWAV[:36]...)
	withJunk = append(withJunk, []byte("JUNK\x08\x00\x00\x00METADATA")...)
	withJunk = append(withJunk, cleanWAV[36:]...)
	binary.LittleEndian.PutUint32(withJunk[4:8], uint32(len(withJunk)-8)) // #nosec G115 -- test fixture size < 100 KB
	disarmed, err := audio.DecodeAndDisarm("with_junk.wav", withJunk)
	if err != nil {
		t.Fatalf("DecodeAndDisarm failed on WAV with JUNK chunk: %v", err)
	}
	reEncoded, err := audio.EncodeWAV(disarmed.Left, disarmed.Right, disarmed.SampleRate, 24)
	if err != nil {
		t.Fatalf("EncodeWAV 24-bit failed: %v", err)
	}
	if len(reEncoded) != 44+disarmed.Frames*6 {
		t.Fatalf("expected stripped canonical 24-bit WAV of %d bytes, got %d", 44+disarmed.Frames*6, len(reEncoded))
	}
}

func TestAllFiveEngineerProfilesAndSectionScriptOrthogonality(t *testing.T) {
	l, r := synthTestMix(48000, 2.0)
	buf := &audio.Buffer{
		SampleRate: 48000,
		Channels:   2,
		Frames:     len(l),
		Duration:   2.0,
		Left:       l,
		Right:      r,
	}

	profiles := []mastering.ProfileID{
		mastering.ProfileWarmAnalog,
		mastering.ProfilePunchyCommercial,
		mastering.ProfileDynamicOpen,
		mastering.ProfileVocalForward,
		mastering.ProfileBassHeavy,
	}

	scripts := make(map[mastering.ProfileID]*mastering.Script)
	for _, prof := range profiles {
		sc, err := mastering.AnalyzeDeep(context.Background(), buf, prof, nil)
		if err != nil {
			t.Fatalf("AnalyzeDeep(%s) failed: %v", prof, err)
		}
		if len(sc.Sections) != 5 || len(sc.Moves) < 8 {
			t.Fatalf("AnalyzeDeep(%s) returned incomplete sections (%d) or moves (%d)", prof, len(sc.Sections), len(sc.Moves))
		}
		scripts[prof] = sc
	}

	// Verify distinct acoustic behavior across profiles:
	// 1. Punchy Commercial targets louder LUFS than Dynamic & Open
	if scripts[mastering.ProfilePunchyCommercial].AfterMetrics.IntegratedLUFS <= scripts[mastering.ProfileDynamicOpen].AfterMetrics.IntegratedLUFS+2.0 {
		t.Fatalf("expected Punchy Commercial (%0.2f LUFS) to be >2 LU louder than Dynamic & Open (%0.2f LUFS)",
			scripts[mastering.ProfilePunchyCommercial].AfterMetrics.IntegratedLUFS,
			scripts[mastering.ProfileDynamicOpen].AfterMetrics.IntegratedLUFS)
	}
	// 2. Bass Heavy has higher 60 Hz gain than Vocal Forward
	if scripts[mastering.ProfileBassHeavy].ChainParams.Bands[0].GainDB <= scripts[mastering.ProfileVocalForward].ChainParams.Bands[0].GainDB+2.0 {
		t.Fatalf("expected Bass Heavy 60Hz gain > Vocal Forward 60Hz gain")
	}

	// 3. Verify that muting a single Chorus Volume move changes Chorus loudness without mutating any other move
	sc := new(mastering.Script)
	*sc = *scripts[mastering.ProfilePunchyCommercial]
	sc.Moves = append([]mastering.Move(nil), sc.Moves...)
	// Isolate the fader measurement from intentional compression/limiting and
	// concurrent tonal automation. Input gain legitimately drives those stages.
	sc.ChainParams = dsp.DefaultParams()
	for i := range sc.Moves {
		if sc.Moves[i].Lane != "volume" {
			sc.Moves[i].Muted = true
		}
	}
	origMoves := make([]mastering.Move, len(sc.Moves))
	copy(origMoves, sc.Moves)

	outActiveL, outActiveR, _ := mastering.RenderScript(buf, sc)
	// Chorus window is [0.44, 0.72] -> frames [42240, 69120]
	chorusActiveM := dsp.MeasureStereo(outActiveL[43000:68000], outActiveR[43000:68000], 48000.0)

	// Mute ONLY move-vol-chorus (and boost its value to +4.0 dB before muting to prove mute disables it)
	targetIdx := -1
	for i := range sc.Moves {
		if sc.Moves[i].ID == "move-vol-chorus" {
			targetIdx = i
			sc.Moves[i].Value = 4.5
			sc.Moves[i].Points = nil // Explicitly exercise the scalar fallback.
			sc.Moves[i].Muted = false
			break
		}
	}
	if targetIdx < 0 {
		t.Fatal("move-vol-chorus not found")
	}
	outBoostedL, outBoostedR, _ := mastering.RenderScript(buf, sc)
	chorusBoostedM := dsp.MeasureStereo(outBoostedL[43000:68000], outBoostedR[43000:68000], 48000.0)

	sc.Moves[targetIdx].Muted = true
	outMutedL, outMutedR, _ := mastering.RenderScript(buf, sc)
	chorusMutedM := dsp.MeasureStereo(outMutedL[43000:68000], outMutedR[43000:68000], 48000.0)
	_ = chorusActiveM

	if chorusBoostedM.SamplePeakDBFS <= chorusMutedM.SamplePeakDBFS+1.0 {
		t.Fatalf("expected unmuted +4.5 dB chorus move (%0.2f dBFS) to lift chorus peak above muted move (%0.2f dBFS)",
			chorusBoostedM.SamplePeakDBFS, chorusMutedM.SamplePeakDBFS)
	}

	// Assert all other moves remained 100% untouched
	for i := range sc.Moves {
		if i == targetIdx {
			continue
		}
		if sc.Moves[i].Value != origMoves[i].Value || sc.Moves[i].Muted != origMoves[i].Muted || sc.Moves[i].ID != origMoves[i].ID {
			t.Fatalf("mutating move %d inadvertently altered move %d", targetIdx, i)
		}
	}
}
