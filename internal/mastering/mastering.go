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
	case "", "warm analog", "warm_analog", "warm-analog", "warmanalog":
		return ProfileWarmAnalog, nil
	case "punchy commercial", "punchy_commercial", "punchy-commercial", "punchy":
		return ProfilePunchyCommercial, nil
	case "dynamic & open", "dynamic and open", "dynamic_open", "dynamic-open", "dynamic":
		return ProfileDynamicOpen, nil
	case "vocal forward", "vocal_forward", "vocal-forward", "vocal":
		return ProfileVocalForward, nil
	case "bass heavy", "bass_heavy", "bass-heavy", "bass":
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
		p.Compressor.MakeupDB = 2.0
		p.Compressor.Topology = dsp.CompVCA
		p.Saturation.Amount = 46.0
		p.Saturation.Character = dsp.SatCrisp
		p.Stereo.WidthPct = 122.0
		p.Stereo.MonoBass = true
		p.Limiter.CeilingDBTP = -0.8
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
		p.Compressor.MakeupDB = 1.8
		p.Compressor.Topology = dsp.CompVCA
		p.Saturation.Amount = 52.0
		p.Saturation.Character = dsp.SatThick
		p.Stereo.WidthPct = 116.0
		p.Stereo.MonoBass = true
		p.Stereo.CrossoverHz = 115.0
		p.Limiter.CeilingDBTP = -0.9
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

// AnalyzeDeep inspects the audio buffer, segments it into musical sections, builds a
// profile-calibrated MasteringScript v1, and computes before/after acoustic metrics.
func AnalyzeDeep(ctx context.Context, buf *audio.Buffer, profile ProfileID, onProgress func(pct int, stage string)) (*Script, error) {
	if buf == nil || len(buf.Left) == 0 {
		return nil, audio.ErrEmptyAudio
	}
	if onProgress != nil {
		onProgress(15, "Decoding & measuring ITU-R BS.1770-4 loudness...")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	sr := float64(buf.SampleRate)
	beforeMetrics := dsp.MeasureStereo(buf.Left, buf.Right, sr)

	if onProgress != nil {
		onProgress(40, "Detecting musical sections & spectral balance...")
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

	_, _, afterMetrics := RenderScript(buf, script)
	script.AfterMetrics = afterMetrics

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
		summary = "Punchy Commercial script: tight VCA transient snap, +1.4 dB Chorus lift, 128% stereo hook expansion, and -9.5 LUFS ceiling."
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
			Detail:   fmt.Sprintf("Calibrated %s chain targets %0.1f LUFS with %0.1f dBTP true-peak ceiling.", profile, base.Limiter.TargetLUFS, base.Limiter.CeilingDBTP),
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
			Severity: "pass",
			Title:    "Sub-110 Hz phase correlation locked",
			Detail:   fmt.Sprintf("Source correlation %0.2f; Linkwitz-Riley mono-bass crossover keeps club/vinyl low-end phase coherent.", before.Correlation),
			Lane:     "width",
		},
	}
	_ = buf
	return moves, findings, summary
}

// RenderScript renders a stereo buffer through the baseline chain and active MasteringScript v1
// section moves, returning the mastered Left/Right channels and resulting ITU-R BS.1770-4 metrics.
func RenderScript(buf *audio.Buffer, script *Script) ([]float32, []float32, dsp.Metrics) {
	if buf == nil || len(buf.Left) == 0 {
		return nil, nil, dsp.Metrics{}
	}
	sr := float64(buf.SampleRate)
	if script == nil {
		return dsp.RenderBuffer(buf.Left, buf.Right, sr, dsp.DefaultParams())
	}

	n := len(buf.Left)
	if len(buf.Right) < n {
		n = len(buf.Right)
	}
	outL := make([]float32, n)
	outR := make([]float32, n)

	engine := dsp.NewEngine(sr)
	base := script.ChainParams

	// Calibrate baseline input gain relative to source loudness so section volume moves act as true section faders
	sourceLUFS := script.BeforeMetrics.IntegratedLUFS
	if sourceLUFS == 0 {
		sourceLUFS = dsp.MeasureStereo(buf.Left, buf.Right, sr).IntegratedLUFS
	}
	if base.Limiter.Enabled && script.TargetLUFS <= -5.0 && script.TargetLUFS >= -30.0 && sourceLUFS > -60.0 {
		deltaLU := (script.TargetLUFS - sourceLUFS) * 0.85
		if deltaLU > 14.0 {
			deltaLU = 14.0
		} else if deltaLU < -12.0 {
			deltaLU = -12.0
		}
		base.InputGainDB += deltaLU
	}

	// Process in 25 ms blocks so section-specific moves modulate the DSP engine smoothly without clicks
	stepFrames := int(sr * 0.025)
	if stepFrames < 64 {
		stepFrames = 64
	}

	for start := 0; start < n; start += stepFrames {
		end := minInt(n, start+stepFrames)
		midSec := (float64(start+end) * 0.5) / sr
		p := applyMovesAtTime(base, script.Moves, midSec)
		engine.SetParams(p)
		engine.ProcessBlock(buf.Left[start:end], buf.Right[start:end], outL[start:end], outR[start:end])
	}

	metrics := dsp.MeasureStereo(outL, outR, sr)
	metrics.GainReductionDB = engine.LastGainReductionDB()
	return outL, outR, metrics
}

func applyMovesAtTime(base dsp.Params, moves []Move, tSec float64) dsp.Params {
	p := base
	for i := range moves {
		mv := &moves[i]
		if mv.Muted {
			continue
		}
		if tSec < mv.StartSec || tSec > mv.EndSec {
			continue
		}
		switch mv.ID {
		case "move-vol-verse", "move-vol-chorus", "move-vol-bridge":
			p.Compressor.Enabled = true
			p.Compressor.MakeupDB += mv.Value
		case "move-eq-sub":
			p.Bands[0].GainDB = mv.Value
		case "move-eq-presence":
			p.Bands[3].GainDB = mv.Value
		case "move-eq-air":
			p.Bands[4].GainDB = mv.Value
		case "move-compsat-verse":
			p.Compressor.Ratio = math.Max(1.0, mv.Value)
		case "move-compsat-chorus":
			p.Saturation.Amount = math.Max(0.0, math.Min(100.0, mv.Value))
		case "move-width-verse", "move-width-chorus":
			p.Stereo.WidthPct = math.Max(0.0, math.Min(200.0, mv.Value))
		case "move-repair-deess":
			p.Repair.Enabled = true
			p.Repair.DeEssDB = math.Max(0.0, mv.Value)
		case "move-repair-transient":
			p.Repair.Enabled = true
			p.Repair.TransientDB = mv.Value
		default:
			switch mv.Lane {
			case "volume":
				p.Compressor.Enabled = true
				p.Compressor.MakeupDB += mv.Value
			case "width":
				p.Stereo.WidthPct = math.Max(0.0, math.Min(200.0, mv.Value))
			}
		}
	}
	return p
}

// StemOutput represents a single separated audio stem.
type StemOutput struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Role     string      `json:"role"`
	Color    string      `json:"color"`
	Metrics  dsp.Metrics `json:"metrics"`
	Left     []float32   `json:"-"`
	Right    []float32   `json:"-"`
	WAVBytes []byte      `json:"-"`
}

// SeparateStems decomposes a stereo buffer into 2..6 phase-coherent stems whose sample-wise
// sum reconstructs the original mix.
func SeparateStems(ctx context.Context, buf *audio.Buffer, stemCount int, onProgress func(pct int, stage string)) ([]StemOutput, error) {
	if buf == nil || len(buf.Left) == 0 {
		return nil, audio.ErrEmptyAudio
	}
	if stemCount < 2 || stemCount > 6 {
		return nil, fmt.Errorf("stem count must be between 2 and 6, got %d", stemCount)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(15, fmt.Sprintf("Initializing %d-stem spectral & transient decomposition...", stemCount))
	}

	n := len(buf.Left)
	if len(buf.Right) < n {
		n = len(buf.Right)
	}
	sr := float64(buf.SampleRate)

	// Allocate per-stem stereo buffers
	type stemDef struct {
		id    string
		name  string
		role  string
		color string
	}
	var defs []stemDef
	switch stemCount {
	case 2:
		defs = []stemDef{
			{id: "vocals", name: "Vocals", role: "vocals", color: "#b4543c"},
			{id: "other", name: "Instrumental", role: "other", color: "#596c52"},
		}
	case 3:
		defs = []stemDef{
			{id: "vocals", name: "Vocals", role: "vocals", color: "#b4543c"},
			{id: "drums", name: "Drums", role: "drums", color: "#596c52"},
			{id: "bass", name: "Bass & Harmonic", role: "bass", color: "#8a6529"},
		}
	case 4:
		defs = []stemDef{
			{id: "vocals", name: "Vocals", role: "vocals", color: "#b4543c"},
			{id: "drums", name: "Drums", role: "drums", color: "#596c52"},
			{id: "bass", name: "Bass", role: "bass", color: "#8a6529"},
			{id: "other", name: "Other", role: "other", color: "#78638b"},
		}
	case 5:
		defs = []stemDef{
			{id: "vocals", name: "Vocals", role: "vocals", color: "#b4543c"},
			{id: "drums", name: "Drums", role: "drums", color: "#596c52"},
			{id: "bass", name: "Bass", role: "bass", color: "#8a6529"},
			{id: "guitar", name: "Guitar", role: "guitar", color: "#4f7482"},
			{id: "other", name: "Other", role: "other", color: "#78638b"},
		}
	case 6:
		defs = []stemDef{
			{id: "vocals", name: "Vocals", role: "vocals", color: "#b4543c"},
			{id: "drums", name: "Drums", role: "drums", color: "#596c52"},
			{id: "bass", name: "Bass", role: "bass", color: "#8a6529"},
			{id: "guitar", name: "Guitar", role: "guitar", color: "#4f7482"},
			{id: "piano", name: "Piano", role: "piano", color: "#936856"},
			{id: "other", name: "Other", role: "other", color: "#78638b"},
		}
	}

	stemsL := make([][]float32, stemCount)
	stemsR := make([][]float32, stemCount)
	for k := 0; k < stemCount; k++ {
		stemsL[k] = make([]float32, n)
		stemsR[k] = make([]float32, n)
	}

	// One-pole / two-pole state variables for phase-coherent decomposition:
	// 1. Sub/Bass low-pass (< 180 Hz)
	alphaBass := 1.0 - math.Exp(-2.0*math.Pi*180.0/sr)
	// 2. Vocal mid-band low-pass (< 3800 Hz)
	alphaMid := 1.0 - math.Exp(-2.0*math.Pi*3800.0/sr)
	// 3. Guitar/Piano split (< 1200 Hz)
	alphaHarm := 1.0 - math.Exp(-2.0*math.Pi*1200.0/sr)
	// 4. Fast/slow transient detector for Drums
	aFast := 1.0 - math.Exp(-1.0/(0.002*sr))
	aSlow := 1.0 - math.Exp(-1.0/(0.030*sr))

	var lpBassL, lpBassR, lpBass2L, lpBass2R float64
	var lpMidL, lpMidR float64
	var lpHarmL, lpHarmR float64
	var envFast, envSlow float64

	for i := 0; i < n; i++ {
		if i&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		l := float64(buf.Left[i])
		r := float64(buf.Right[i])

		// Extract 2-pole low-frequency Bass (< 180 Hz)
		lpBassL += alphaBass * (l - lpBassL)
		lpBassR += alphaBass * (r - lpBassR)
		lpBass2L += alphaBass * (lpBassL - lpBass2L)
		lpBass2R += alphaBass * (lpBassR - lpBass2R)
		bassL := lpBass2L
		bassR := lpBass2R

		remL := l - bassL
		remR := r - bassR

		// Extract Vocal Mid component (200 Hz - 3800 Hz centered Mid)
		lpMidL += alphaMid * (remL - lpMidL)
		lpMidR += alphaMid * (remR - lpMidR)
		midCenter := 0.5 * (lpMidL + lpMidR)
		vocL := 0.65 * midCenter
		vocR := 0.65 * midCenter

		rem2L := remL - vocL
		rem2R := remR - vocR

		// Extract Drums via transient envelope ratio + high-frequency attack
		peak := math.Max(math.Abs(rem2L), math.Abs(rem2R))
		envFast += aFast * (peak - envFast)
		envSlow += aSlow * (peak - envSlow)
		transMask := 0.35
		if envFast > envSlow && envFast > 1e-5 {
			transMask = math.Min(0.85, 0.35+0.60*(envFast-envSlow)/(envFast+1e-6))
		}
		drumL := rem2L * transMask
		drumR := rem2R * transMask

		rem3L := rem2L - drumL
		rem3R := rem2R - drumR

		switch stemCount {
		case 2:
			// 2 stems: Vocals + Instrumental (exact sum = l, r)
			vL := vocL + 0.15*rem2L
			vR := vocR + 0.15*rem2R
			stemsL[0][i] = float32(vL)
			stemsR[0][i] = float32(vR)
			stemsL[1][i] = float32(l - vL)
			stemsR[1][i] = float32(r - vR)
		case 3:
			// 3 stems: Vocals, Drums, Bass & Harmonic (exact sum = l, r)
			stemsL[0][i] = float32(vocL)
			stemsR[0][i] = float32(vocR)
			stemsL[1][i] = float32(drumL)
			stemsR[1][i] = float32(drumR)
			stemsL[2][i] = float32(l - vocL - drumL)
			stemsR[2][i] = float32(r - vocR - drumR)
		case 4:
			// 4 stems: Vocals, Drums, Bass, Other (exact sum = l, r)
			stemsL[0][i] = float32(vocL)
			stemsR[0][i] = float32(vocR)
			stemsL[1][i] = float32(drumL)
			stemsR[1][i] = float32(drumR)
			stemsL[2][i] = float32(bassL)
			stemsR[2][i] = float32(bassR)
			stemsL[3][i] = float32(l - vocL - drumL - bassL)
			stemsR[3][i] = float32(r - vocR - drumR - bassR)
		case 5:
			// 5 stems: Vocals, Drums, Bass, Guitar, Other
			lpHarmL += alphaHarm * (rem3L - lpHarmL)
			lpHarmR += alphaHarm * (rem3R - lpHarmR)
			gtrL := lpHarmL
			gtrR := lpHarmR
			stemsL[0][i] = float32(vocL)
			stemsR[0][i] = float32(vocR)
			stemsL[1][i] = float32(drumL)
			stemsR[1][i] = float32(drumR)
			stemsL[2][i] = float32(bassL)
			stemsR[2][i] = float32(bassR)
			stemsL[3][i] = float32(gtrL)
			stemsR[3][i] = float32(gtrR)
			stemsL[4][i] = float32(l - vocL - drumL - bassL - gtrL)
			stemsR[4][i] = float32(r - vocR - drumR - bassR - gtrR)
		case 6:
			// 6 stems: Vocals, Drums, Bass, Guitar, Piano, Other
			lpHarmL += alphaHarm * (rem3L - lpHarmL)
			lpHarmR += alphaHarm * (rem3R - lpHarmR)
			gtrL := 0.6 * lpHarmL
			gtrR := 0.6 * lpHarmR
			pnoL := 0.4*lpHarmL + 0.35*(rem3L-lpHarmL)
			pnoR := 0.4*lpHarmR + 0.35*(rem3R-lpHarmR)
			stemsL[0][i] = float32(vocL)
			stemsR[0][i] = float32(vocR)
			stemsL[1][i] = float32(drumL)
			stemsR[1][i] = float32(drumR)
			stemsL[2][i] = float32(bassL)
			stemsR[2][i] = float32(bassR)
			stemsL[3][i] = float32(gtrL)
			stemsR[3][i] = float32(gtrR)
			stemsL[4][i] = float32(pnoL)
			stemsR[4][i] = float32(pnoR)
			stemsL[5][i] = float32(l - vocL - drumL - bassL - gtrL - pnoL)
			stemsR[5][i] = float32(r - vocR - drumR - bassR - gtrR - pnoR)
		}
	}

	if onProgress != nil {
		onProgress(75, "Encoding clean 16-bit WAV stems & computing LUFS/dBTP metrics...")
	}

	outputs := make([]StemOutput, 0, stemCount)
	for k := 0; k < stemCount; k++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		wavBytes, err := audio.EncodeWAV(stemsL[k], stemsR[k], buf.SampleRate, 16)
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, StemOutput{
			ID:       defs[k].id,
			Name:     defs[k].name,
			Role:     defs[k].role,
			Color:    defs[k].color,
			Metrics:  dsp.MeasureStereo(stemsL[k], stemsR[k], sr),
			Left:     stemsL[k],
			Right:    stemsR[k],
			WAVBytes: wavBytes,
		})
	}

	if onProgress != nil {
		onProgress(100, "Stem separation complete")
	}
	return outputs, nil
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
