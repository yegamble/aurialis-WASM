// Package mastering implements the in-house AI/LLM & deterministic MasteringScript v1
// analysis engine, 5 engineer profiles, section-envelope rendering, and 2-6 stem separation.
package mastering

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// ProfileID identifies one of the 5 studio mastering engineer profiles.
type ProfileID string

const (
	// ProfileWarmAnalog models a Pultec EQ + triode tube + optical LA-2A chain.
	ProfileWarmAnalog ProfileID = "Warm Analog"
	// ProfilePunchyCommercial models a modern streaming/club VCA + transformer + brickwall chain.
	ProfilePunchyCommercial ProfileID = "Punchy Commercial"
	// ProfileDynamicOpen models a wide-dynamic-range audiophile chain.
	ProfileDynamicOpen ProfileID = "Dynamic & Open"
	// ProfileVocalForward models a midrange vocal-presence + de-esser chain.
	ProfileVocalForward ProfileID = "Vocal Forward"
	// ProfileBassHeavy models a sub-bass weight + 115 Hz sidechain HPF + mono-bass chain.
	ProfileBassHeavy ProfileID = "Bass Heavy"
)

// NormalizeProfile maps a raw profile query/form string to a canonical ProfileID.
func NormalizeProfile(raw string) (ProfileID, error) {
	clean := strings.TrimSpace(strings.ToLower(raw))
	switch clean {
	case "", "warm analog", "warm_analog", "warm-analog", "warmanalog", "indie_warmth", "indie warmth":
		return ProfileWarmAnalog, nil
	case "punchy commercial", "punchy_commercial", "punchy-commercial", "punchy", "modern_pop_polish", "modern pop polish", "metal_wall", "metal wall":
		return ProfilePunchyCommercial, nil
	case "dynamic & open", "dynamic and open", "dynamic_open", "dynamic-open", "dynamic", "pop_punk_air", "pop punk air":
		return ProfileDynamicOpen, nil
	case "vocal forward", "vocal_forward", "vocal-forward", "vocal":
		return ProfileVocalForward, nil
	case "bass heavy", "bass_heavy", "bass-heavy", "bass", "hip_hop_low_end", "hip-hop low-end":
		return ProfileBassHeavy, nil
	default:
		return "", fmt.Errorf("unsupported engineer profile %q", raw)
	}
}

// Section represents a detected musical section on the track timeline.
type Section struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Label    string  `json:"label"`
	StartSec float64 `json:"startSec"`
	EndSec   float64 `json:"endSec"`
	EnergyDB float64 `json:"energyDb"`
	Role     string  `json:"role"`
}

// Move represents a time-automation move in one of the 5 Deep mastering lanes.
type Move struct {
	ID           string       `json:"id"`
	Lane         string       `json:"lane"`
	SectionID    string       `json:"sectionId"`
	SectionName  string       `json:"sectionName"`
	Label        string       `json:"label"`
	Summary      string       `json:"summary"`
	Reason       string       `json:"reason"`
	Unit         string       `json:"unit"`
	Value        float64      `json:"value"`
	DefaultValue float64      `json:"defaultValue"`
	Min          float64      `json:"min"`
	Max          float64      `json:"max"`
	Step         float64      `json:"step"`
	StartSec     float64      `json:"startSec"`
	EndSec       float64      `json:"endSec"`
	Points       [][2]float64 `json:"points"`
	Muted        bool         `json:"muted"`
	Edited       bool         `json:"edited"`
}

// Finding represents an acoustic diagnostic observation discovered during Deep analysis.
type Finding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Lane     string `json:"lane"`
}

// Script is the versioned MasteringScript v1 JSON payload returned by /analyze/deep.
type Script struct {
	Version       string      `json:"version"`
	Profile       ProfileID   `json:"profile"`
	Summary       string      `json:"summary"`
	TargetLUFS    float64     `json:"targetLufs"`
	CeilingDBTP   float64     `json:"ceilingDbtp"`
	Sections      []Section   `json:"sections"`
	Moves         []Move      `json:"moves"`
	Findings      []Finding   `json:"findings"`
	ChainParams   dsp.Params  `json:"chainParams"`
	BeforeMetrics dsp.Metrics `json:"beforeMetrics"`
	AfterMetrics  dsp.Metrics `json:"afterMetrics"`
}

// ProfilePreset returns the calibrated baseline DSP parameters for a given ProfileID.
func ProfilePreset(profile ProfileID) dsp.Params {
	p := dsp.DefaultParams()
	p.EQEnabled = true
	p.Compressor.Enabled = true
	p.Saturation.Enabled = true
	p.Stereo.Enabled = true
	p.Limiter.Enabled = true
	p.Limiter.TruePeak = true
	p.Repair.Enabled = true

	switch profile {
	case ProfilePunchyCommercial:
		p.InputGainDB = 1.5
		p.Bands[0].GainDB = 2.4  // 60 Hz sub punch
		p.Bands[1].GainDB = -1.4 // 250 Hz boxiness cut
		p.Bands[2].GainDB = 0.6  // 1 kHz attack
		p.Bands[3].GainDB = 1.8  // 4 kHz presence
		p.Bands[4].GainDB = 2.2  // 12 kHz air
		p.Compressor.ThresholdDB = -18.0
		p.Compressor.Ratio = 3.2
		p.Compressor.AttackMS = 16.0
		p.Compressor.ReleaseMS = 95.0
		p.Compressor.MakeupDB = 7.5 // Replaces loudness the former saturation gain supplied
		p.Compressor.Topology = dsp.CompVCA
		p.Saturation.Amount = 46.0
		p.Saturation.Character = dsp.SatCrisp
		p.Stereo.WidthPct = 122.0
		p.Stereo.MonoBass = true
		p.Limiter.CeilingDBTP = MaxStartingCeilingDBTP
		p.Limiter.TargetLUFS = -9.5
		p.Repair.TransientDB = 1.6
	case ProfileDynamicOpen:
		p.InputGainDB = 0.0
		p.Bands[0].GainDB = 0.8
		p.Bands[1].GainDB = -0.6
		p.Bands[2].GainDB = 0.0
		p.Bands[3].GainDB = 0.5
		p.Bands[4].GainDB = 1.5
		p.Compressor.ThresholdDB = -14.0
		p.Compressor.Ratio = 1.5
		p.Compressor.AttackMS = 35.0
		p.Compressor.ReleaseMS = 220.0
		p.Compressor.MakeupDB = 0.5
		p.Compressor.Topology = dsp.CompVariableMu
		p.Saturation.Amount = 18.0
		p.Saturation.Character = dsp.SatWarm
		p.Stereo.WidthPct = 110.0
		p.Stereo.MonoBass = false
		p.Limiter.CeilingDBTP = -1.0
		p.Limiter.TargetLUFS = -14.0
	case ProfileVocalForward:
		p.InputGainDB = 0.8
		p.Bands[0].GainDB = 0.6
		p.Bands[1].GainDB = -1.8 // Clear low-mid masking around vocals
		p.Bands[2].GainDB = 2.5  // 1 kHz vocal body focal lift
		p.Bands[3].GainDB = 2.1  // 4 kHz vocal articulation
		p.Bands[4].GainDB = 1.6  // 12 kHz breath/air
		p.Compressor.ThresholdDB = -17.0
		p.Compressor.Ratio = 2.4
		p.Compressor.AttackMS = 22.0
		p.Compressor.ReleaseMS = 130.0
		p.Compressor.MakeupDB = 1.5
		p.Compressor.Topology = dsp.CompOptical
		p.Saturation.Amount = 32.0
		p.Saturation.Character = dsp.SatWarm
		p.Stereo.WidthPct = 112.0
		p.Stereo.MonoBass = true
		p.Limiter.CeilingDBTP = -1.0
		p.Limiter.TargetLUFS = -12.0
		p.Repair.DeEssDB = 4.2
	case ProfileBassHeavy:
		p.InputGainDB = 1.2
		p.Bands[0].GainDB = 4.2  // 60 Hz sub-bass foundation boost
		p.Bands[1].GainDB = -1.5 // 250 Hz mud carve for clean sub separation
		p.Bands[2].GainDB = 0.2
		p.Bands[3].GainDB = 1.0
		p.Bands[4].GainDB = 1.4
		p.Compressor.ThresholdDB = -16.5
		p.Compressor.Ratio = 2.8
		p.Compressor.AttackMS = 24.0
		p.Compressor.ReleaseMS = 110.0
		p.Compressor.SidechainHPFHz = 115.0 // High sidechain HPF so 808/sub doesn't pump
		p.Compressor.MakeupDB = 7.5         // Replaces loudness the former saturation gain supplied
		p.Compressor.Topology = dsp.CompVCA
		p.Saturation.Amount = 52.0
		p.Saturation.Character = dsp.SatThick
		p.Stereo.WidthPct = 116.0
		p.Stereo.MonoBass = true
		p.Stereo.CrossoverHz = 115.0
		p.Limiter.CeilingDBTP = MaxStartingCeilingDBTP
		p.Limiter.TargetLUFS = -10.5
	case ProfileWarmAnalog:
		fallthrough
	default:
		p.InputGainDB = 0.6
		p.Bands[0].GainDB = 2.1  // Pultec-style 60 Hz warmth
		p.Bands[1].GainDB = 0.5  // Warm low-mid body
		p.Bands[2].GainDB = -0.3 // Gentle mid dip
		p.Bands[3].GainDB = -1.2 // Smooth upper-mid harshness
		p.Bands[4].GainDB = 1.2  // Silk air shelf
		p.Compressor.ThresholdDB = -16.0
		p.Compressor.Ratio = 2.1
		p.Compressor.AttackMS = 25.0
		p.Compressor.ReleaseMS = 160.0
		p.Compressor.MakeupDB = 1.2
		p.Compressor.Topology = dsp.CompOptical
		p.Saturation.Amount = 44.0
		p.Saturation.Character = dsp.SatWarm
		p.Stereo.WidthPct = 108.0
		p.Stereo.MonoBass = true
		p.Limiter.CeilingDBTP = -1.0
		p.Limiter.TargetLUFS = -12.5
	}
	return p
}

// AnalyzeDeep measures fixed fractional regions of the audio buffer, builds a
// profile-calibrated MasteringScript v1, and computes before/after acoustic metrics.
func AnalyzeDeep(ctx context.Context, buf *audio.Buffer, profile ProfileID, onProgress func(pct int, stage string)) (*Script, error) {
	if err := validateStereoBuffer(ctx, buf); err != nil {
		return nil, err
	}
	canonical, profileErr := NormalizeProfile(string(profile))
	if profileErr != nil {
		return nil, profileErr
	}
	profile = canonical
	if onProgress != nil {
		onProgress(15, "Measuring stereo level estimates...")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	sr := float64(buf.SampleRate)
	beforeMetrics, measureErr := dsp.MeasureStereoContext(ctx, buf.Left, buf.Right, sr)
	if measureErr != nil {
		return nil, measureErr
	}

	if onProgress != nil {
		onProgress(40, "Measuring fixed timeline regions and energy...")
	}
	sections := detectSections(buf)
	chainParams := ProfilePreset(profile)
	moves, findings, summary := buildProfileMovesAndFindings(buf, sections, profile, beforeMetrics, chainParams)

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(75, "Simulating section-by-section MasteringScript v1...")
	}

	script := &Script{
		Version:       "1.0",
		Profile:       profile,
		Summary:       summary,
		TargetLUFS:    chainParams.Limiter.TargetLUFS,
		CeilingDBTP:   chainParams.Limiter.CeilingDBTP,
		Sections:      sections,
		Moves:         moves,
		Findings:      findings,
		ChainParams:   chainParams,
		BeforeMetrics: beforeMetrics,
	}

	_, _, afterMetrics, renderErr := RenderScriptContext(ctx, buf, script)
	if renderErr != nil {
		return nil, renderErr
	}
	script.AfterMetrics = afterMetrics
	script.Findings = append(script.Findings, predictionFindings(beforeMetrics, afterMetrics, nil)...)

	if onProgress != nil {
		onProgress(100, "Deep MasteringScript v1 ready")
	}
	return script, nil
}

func detectSections(buf *audio.Buffer) []Section {
	dur := buf.Duration
	if dur <= 0 {
		dur = float64(len(buf.Left)) / float64(maxInt(buf.SampleRate, 48000))
	}
	type secSpec struct {
		id    string
		name  string
		role  string
		sFrac float64
		eFrac float64
	}
	specs := []secSpec{
		{id: "sec-intro", name: "Intro", role: "intro", sFrac: 0.00, eFrac: 0.16},
		{id: "sec-verse", name: "Verse", role: "verse", sFrac: 0.16, eFrac: 0.44},
		{id: "sec-chorus", name: "Chorus", role: "chorus", sFrac: 0.44, eFrac: 0.72},
		{id: "sec-bridge", name: "Bridge", role: "bridge", sFrac: 0.72, eFrac: 0.86},
		{id: "sec-outro", name: "Outro", role: "outro", sFrac: 0.86, eFrac: 1.00},
	}

	n := len(buf.Left)
	sections := make([]Section, 0, len(specs))
	for _, sp := range specs {
		sIdx := int(sp.sFrac * float64(n))
		eIdx := int(sp.eFrac * float64(n))
		if eIdx <= sIdx {
			eIdx = minInt(n, sIdx+1)
		}
		var sumSq float64
		count := eIdx - sIdx
		for i := sIdx; i < eIdx && i < n; i++ {
			l := float64(buf.Left[i])
			r := float64(buf.Right[i])
			sumSq += 0.5 * (l*l + r*r)
		}
		rmsDB := -60.0
		if count > 0 && sumSq > 1e-12 {
			rmsDB = 10.0 * math.Log10(sumSq/float64(count))
		}
		sections = append(sections, Section{
			ID:       sp.id,
			Name:     sp.name,
			Label:    sp.name,
			StartSec: math.Round(sp.sFrac*dur*100.0) / 100.0,
			EndSec:   math.Round(sp.eFrac*dur*100.0) / 100.0,
			EnergyDB: math.Round(rmsDB*10.0) / 10.0,
			Role:     sp.role,
		})
	}
	return sections
}

func buildProfileMovesAndFindings(buf *audio.Buffer, sections []Section, profile ProfileID, before dsp.Metrics, base dsp.Params) ([]Move, []Finding, string) {
	var (
		volVerse, volChorus, volBridge float64
		eqSub, eqPresence, eqAir       float64
		compDrive, satAmt              float64
		widthVerse, widthChorus        float64
		deEss, transientLift           float64
		summary                        string
	)

	switch profile {
	case ProfilePunchyCommercial:
		volVerse, volChorus, volBridge = 0.2, 1.4, -0.3
		eqSub, eqPresence, eqAir = 2.4, 1.8, 2.2
		compDrive, satAmt = 3.2, 46.0
		widthVerse, widthChorus = 108.0, 128.0
		deEss, transientLift = 2.0, 2.2
		summary = "Punchy Commercial script: tight VCA transient snap, +1.4 dB Chorus lift, 128% stereo hook expansion, and a requested -9.5 LUFS target."
	case ProfileDynamicOpen:
		volVerse, volChorus, volBridge = 0.0, 0.7, -0.4
		eqSub, eqPresence, eqAir = 0.8, 0.5, 1.5
		compDrive, satAmt = 1.5, 18.0
		widthVerse, widthChorus = 104.0, 114.0
		deEss, transientLift = 1.0, 0.8
		summary = "Dynamic & Open script: preserves micro-dynamics and crest factor with gentle Vari-Mu glue and airy 12 kHz openness."
	case ProfileVocalForward:
		volVerse, volChorus, volBridge = 0.4, 1.0, 0.2
		eqSub, eqPresence, eqAir = 0.6, 2.5, 1.8
		compDrive, satAmt = 2.4, 32.0
		widthVerse, widthChorus = 105.0, 116.0
		deEss, transientLift = 4.5, 0.6
		summary = "Vocal Forward script: carves 250 Hz masking, lifts 1-4 kHz lead presence, and applies dynamic 6.5 kHz sibilance control."
	case ProfileBassHeavy:
		volVerse, volChorus, volBridge = 0.3, 1.2, 0.0
		eqSub, eqPresence, eqAir = 4.2, 1.0, 1.4
		compDrive, satAmt = 2.8, 52.0
		widthVerse, widthChorus = 106.0, 120.0
		deEss, transientLift = 1.5, 1.4
		summary = "Bass Heavy script: reinforces 60 Hz sub-bass (+4.2 dB), locks <115 Hz in mono, and shields the compressor sidechain at 115 Hz."
	case ProfileWarmAnalog:
		fallthrough
	default:
		volVerse, volChorus, volBridge = 0.1, 0.9, -0.2
		eqSub, eqPresence, eqAir = 2.1, -1.2, 1.2
		compDrive, satAmt = 2.1, 44.0
		widthVerse, widthChorus = 104.0, 114.0
		deEss, transientLift = 2.4, 0.5
		summary = "Warm Analog script: Pultec low-end weight, asymmetric triode H2 warmth, smooth 4 kHz de-harshing, and gentle optical leveling."
	}

	moves := make([]Move, 0, 10)
	addMove := func(id, lane string, sec Section, label, reason, unit string, val, minV, maxV, stepV float64) {
		moves = append(moves, Move{
			ID:           id,
			Lane:         lane,
			SectionID:    sec.ID,
			SectionName:  sec.Name,
			Label:        label,
			Summary:      fmt.Sprintf("%s (%s): %0.1f %s", label, sec.Name, val, unit),
			Reason:       reason,
			Unit:         unit,
			Value:        val,
			DefaultValue: val,
			Min:          minV,
			Max:          maxV,
			Step:         stepV,
			StartSec:     sec.StartSec,
			EndSec:       sec.EndSec,
			Points: [][2]float64{
				{sec.StartSec, val},
				{sec.EndSec, val},
			},
			Muted:  false,
			Edited: false,
		})
	}

	if len(sections) >= 5 {
		addMove("move-vol-verse", "volume", sections[1], "Verse Level Trim", "Establish steady vocal and rhythm foundation before the hook", "dB", volVerse, -6.0, 6.0, 0.1)
		addMove("move-vol-chorus", "volume", sections[2], "Chorus Impact Lift", "Step up hook loudness for emotional lift without clipping", "dB", volChorus, -6.0, 6.0, 0.1)
		addMove("move-vol-bridge", "volume", sections[3], "Bridge Contrast", "Create dynamic breathing room before the final outro", "dB", volBridge, -6.0, 6.0, 0.1)

		addMove("move-eq-sub", "eq", sections[1], "Low Foundation Shelf", "Shape 60 Hz sub-bass weight according to "+string(profile)+" contour", "dB", eqSub, -6.0, 6.0, 0.1)
		addMove("move-eq-presence", "eq", sections[2], "Chorus Presence Contour", "Contour 1-4 kHz focal presence during the dense chorus", "dB", eqPresence, -6.0, 6.0, 0.1)
		addMove("move-eq-air", "eq", sections[4], "Air & Harmonic Sheen", "Open 12 kHz top-end air across the outro tail", "dB", eqAir, -6.0, 6.0, 0.1)

		addMove("move-compsat-verse", "comp_sat", sections[1], "Analog Glue Ratio", "Set program-dependent compression ratio for steady pocket", ":1", compDrive, 1.0, 8.0, 0.1)
		addMove("move-compsat-chorus", "comp_sat", sections[2], "Harmonic Saturation Drive", "Add "+string(base.Saturation.Character)+" harmonic density on chorus peaks", "%", satAmt, 0.0, 100.0, 1.0)

		addMove("move-width-verse", "width", sections[1], "Focused Verse Stage", "Keep verse centered and intimate with tight mono low-end", "%", widthVerse, 50.0, 180.0, 1.0)
		addMove("move-width-chorus", "width", sections[2], "Wide Chorus Panorama", "Widen Side channel above 110 Hz during the chorus", "%", widthChorus, 50.0, 180.0, 1.0)

		addMove("move-repair-deess", "ai_repair", sections[1], "Sibilance Control", "Tame 6.5 kHz harshness without dulling vocal air", "dB", deEss, 0.0, 10.0, 0.1)
		addMove("move-repair-transient", "ai_repair", sections[2], "Transient Articulation", "Shape drum and attack definition across the chorus", "dB", transientLift, -6.0, 6.0, 0.1)
	}

	findings := []Finding{
		{
			ID:       "find-loudness",
			Severity: "info",
			Title:    fmt.Sprintf("Source integrated loudness at %0.1f LUFS", before.IntegratedLUFS),
			Detail:   fmt.Sprintf("%s requests %0.1f LUFS with a %0.1f dBTP limiter setting; target metadata does not normalize gain.", profile, base.Limiter.TargetLUFS, base.Limiter.CeilingDBTP),
			Lane:     "volume",
		},
		{
			ID:       "find-tonal",
			Severity: "consider",
			Title:    fmt.Sprintf("%s tonal balance contour applied", profile),
			Detail:   fmt.Sprintf("Low shelf %+0.1f dB (60 Hz), focal presence %+0.1f dB, and %s harmonic saturation (%0.0f%%).", eqSub, eqPresence, base.Saturation.Character, satAmt),
			Lane:     "eq",
		},
		{
			ID:       "find-stereo",
			Severity: "info",
			Title:    "Mono-bass crossover configured",
			Detail:   fmt.Sprintf("Source correlation %0.2f; the configured mono-bass crossover is a processing choice, not a phase-translation certification.", before.Correlation),
			Lane:     "width",
		},
	}
	_ = buf
	return moves, findings, summary
}

// RenderScript renders a validated script. Invalid input returns empty audio;
// callers that need error or cancellation details should use RenderScriptContext.
func RenderScript(buf *audio.Buffer, script *Script) ([]float32, []float32, dsp.Metrics) {
	left, right, metrics, _ := RenderScriptContext(context.Background(), buf, script)
	return left, right, metrics
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
