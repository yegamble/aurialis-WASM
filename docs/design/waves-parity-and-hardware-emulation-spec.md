# Mastering upgrade specification
<!-- cspell:words stopband prewarp RMSDB Rane -->

Status: proposed, not implemented or acoustically certified. Audit baseline: `fadd96cce72fefb147214572a540a9caf305d467`, 2026-10-22 UTC. This document fulfils the blueprint's specification-first step. Application code is unchanged by this research. Numerical tolerances below are proposed acceptance gates, not measured results.

## 1. Findings against the current implementation

| Area and source | Confirmed implementation | Required change |
| --- | --- | --- |
| `src/lib/live-controls.ts`, `wasm/dsp/live_controls.go` | 81 Float64 controls, 664-byte shared packet; 56-value legacy prefix | Preserve indices; negotiate any new ABI. Do not rebuild against the blueprint's obsolete 56-value contract. |
| `internal/audio/dsp/engine.go:processCompressorSample` | One linked peak-detector transfer curve for all topology labels | Distinct tested algorithms, explicit version migration. `compSlowDB` is already used by automatic release. |
| `internal/audio/dsp/extended.go:recomputeExtended` | Auto release uses 80–800 ms coefficients and 0.5 s memory | Preserve legacy behavior; add separate topology state rather than repurposing live state. |
| `engine.go:processSaturationSample`, `extended.go` | Legacy Warm/Thick/Crisp plus Clean/Tube/Tape/Transformer; midpoint interpolation and averaging, with ADAA | Proper interpolation and decimation filters, compensated delay, independent tape/transformer state. Preserve legacy sound. |
| `engine.go:processStereoSample` | Four cascaded second-order Side high-pass stages, cutoff multiplied by 1.45 | Matched LR4 Mid/Side phase response with explicit compatibility mode. |
| `engine.go:processLimiterSample`, `meter_math.go` | Instantaneous sample clamp; optional cubic estimate; separate metering FIR | Lookahead gain scheduling and independently verified reconstructed-output peaks. Metering code alone is not a limiter. |
| `internal/mastering/mastering.go:detectSections` | Fixed fractional regions with measured regional energy | Signal-based boundaries, uncertainty, neutral labels when musical role is unknown. |
| `internal/mastering/render.go:RenderScriptContext` | Offline sample-timed envelopes and 10 ms fades exist | Typed target routing, version validation, bounded compile step and live/export common evaluator. |
| `internal/server/server.go` render route | Renders params/profile, not a submitted script | Explicit script render contract and validation. |
| `src/components/shared/AdvancedDynamics.tsx` | Makeup, knee, SC HPF, auto release, M/S, mono-bass frequency, De-Harsh, multiband and shortcuts already exposed | Add only genuinely missing supported controls; do not duplicate modules. |
| `src/components/AurialisWorkstation.tsx` | Deep applies a static profile; Reference blends saved EQ settings | Actual analysis requests, cancellable progress, shared automation playback and measured reference matching. |

The earlier 186 unit / 47 browser test checkpoint validates the existing implementation, not these proposals. Code inspection does not establish sonic equivalence to commercial plugins.

## 2. Corrections to the supplied blueprint

- Hardware names describe research references, not validated emulations. Use Optical, Variable-Mu, VCA and FET labels until measured hardware response datasets justify specific product names.
- Blending two release coefficients creates a time-varying single pole; it does not by itself reproduce a dual-stage optical cell. Separate fast and slow states are needed.
- The proposed variable-mu equation still depends on threshold T. Describe it as a smooth progressive curve, not threshold-free hardware physics.
- A detector HPF is not automatically API THRUST modeling. A low-frequency weighted waveshaper is not a hysteresis or transformer circuit solver.
- A two-state `ironHP` array cannot also store a general multistage anti-alias filter, tape response and magnetic memory. Allocate distinct fixed state for each stage.
- LR4 branches sum to an all-pass response: flat magnitude and matching branch phase, not zero phase shift. Preserve matching Mid and Side paths and compensate parallel paths.
- 64 samples means 8 ms at 8 kHz, 1.333 ms at 48 kHz and 0.333 ms at 192 kHz. Choose a time-based lookahead with bounded storage, not conflicting fixed-time and fixed-sample promises.
- A 4x input peak estimate does not guarantee the output after time-varying gain, dither or later stages respects a true-peak ceiling. Independently measure the final signal.
- Pink-noise power density decreases 3 dB per octave; equal logarithmic bands contain equal expected energy. A −4.5 dB/octave target is a creative contour, not the definition of pink noise. Unequal-width band energies must not be compared as if they had equal bandwidth.
- Crest factor is peak-to-RMS, not loudness range and not proof that dynamics can be recovered. Transient enhancement cannot reconstruct information destroyed by clipping/compression.
- Energy/centroid/width novelty can find changes, but cannot reliably identify verses or choruses. Emit confidence and editable neutral section names.
- The genre table is a set of suggested creative moves, not published Waves recipes or source-dependent recommendations. Do not replace conservative defaults with large boosts and drive solely from a genre label.
- Keep A Processed as default and B Original at actual output level, per the established user preference. The user confirmed specification-only scope and unchanged A/B after reviewing this conflict. Do not add level matching in these slices.

## 3. Version and latency contract before sonic changes

Introduce explicit engine behavior versions. Missing version in saved projects/API requests maps to the current behavior. A user chooses an upgrade that creates a recoverable project revision. Do not reinterpret legacy Warm/Thick/Crisp or topology labels in place.

Proposed Go additions (design declarations, not current code):

```go
// Add to Params, validate values 1 and 2; normalize omitted 0 to 1.
AlgorithmVersion uint32 `json:"algorithmVersion"`

// Add to Engine. NewEngine initializes fixed buffers before processing.
v2 studioState

const maxLookaheadFrames = 384 // 2 ms at supported maximum 192 kHz
const maxOversamplingDelay = 128
const maxStudioDelay = maxLookaheadFrames + maxOversamplingDelay + 16

type lr4Bank struct {
    low, high [2][2]svfState // Mid/Side, then cascaded sections
    coeffs svfCoeffs
}

type studioState struct {
    compPower, compFastGR, compSlowGR, compMemory float64
    tubeDC [2]float64
    tapeHead [2]svfState
    tapeHF [2]float64
    transformerFlux [2]float64
    upHistory, downHistory [2][65]float64
    upCursor, downCursor int
    crossover [2]lr4Bank // old/new banks for transition
    crossoverActive, crossoverFadeFrame, crossoverFadeLength int
    rawDelay, saturationDryDelay [2][maxStudioDelay]float64
    rawCursor, saturationDryCursor int
    limiterPeak peakInterpolator
    delay [2][maxStudioDelay]float64 // limiter audio only
    gainPlan [maxStudioDelay]float64
    cursor, delayFrames, lookaheadFrames int
    limiterFast, limiterSlow float64
}
```

Separate the serial stage histories inside the implementation; these fields must not overlap storage with unrelated filters. `maxStudioDelay` is a budget to validate against actual filter delay, not an arbitrary value to report as latency. Coefficients are generated once at setup or accepted parameter changes, with no per-sample trigonometry or allocation.

Add `LatencyFrames() int` and a bounded drain operation to the DSP interface. Append the version as control index 81 only after introducing a capability/version handshake; v2 packets contain 82 values (672 bytes including the existing header). Reject unknown versions and wrong lengths before processing. Update Go decoder, TS encoder, worklet length constants, offline JS wrapper and fixtures together. Existing 81-value fixtures must continue to exercise v1.

Latency must be constant within a prepared graph across bypass, saturation drive/model and limiter toggles. Delay dry A/B and parallel wet/dry paths by the same measured number of frames. The current approximately 80 ms transport alignment delay is not a substitute for accounting for added DSP latency. Seek/reset must clear history and prime the graph without leaking earlier audio. Offline render feeds/drains the delay, discards startup padding and returns exactly the source frame count, including the final transient. Live EOF drains before ending/repeating. Compare timestamps, not merely RMS, across A/B.

## 4. DSP algorithms and acoustic gates

### Compressor topologies

Keep stereo detection linked. Define gain reduction as a nonnegative dB quantity. Specify whether Attack/Release controls use 63.2% time constants or the current 91.8% settling convention; v1 retains its convention. For v2 use `a(tau)=exp(-1/(fs*tau))` with `tau` in seconds (UI milliseconds × 1e-3), with UI documentation and tests consistent with that definition.

- Optical: maintain fast gain reduction and slow exposure memory separately. Initial candidate: 60 ms fast recovery, 1.2 s exposure integration, a 0.5–3.5 s slow recovery varying with exposure. Blend the two reduction states using bounded exposure. Soft knee at least 6 dB. These are calibration candidates, not an LA-2A replica claim.
- Variable-Mu: a continuous progressive gain-reduction curve may start with `x=max(0,detectorDb-(thresholdDb-6))`, `r=1+(ratio-1)*x/(x+6)`, `GR=x*(1-1/r)`. Test continuity and monotonicity. Keep coloration as a separately controlled anti-aliased stage; do not silently add a second saturation stage on topology selection.
- VCA: smoothed linked channel power `p=max(L²,R²)`, RMS detector `10*log10(max(smoothedPower,epsilon))`, conventional soft knee, manual release or crest-adaptive automatic recovery. A candidate 60–600 ms range requires burst and sustained-signal tuning. Do not claim bass pumping is impossible.
- FET: bounded fast attack, initially 0.25 times user attack, tight continuous knee. Validate the shortest supported control value; this scaling is not evidence of a real 1176 time range.

Tests: level sweep −60 to 0 dBFS; finite monotonic transfer; ratio=1 and makeup=0 unity within 1e-6 in the linear compressor-only path; steady-state model error ≤0.1 dB; declared settling within 10% plus one detector window; optical long-burst recovery demonstrably slower than short-burst recovery; distinct curves/ballistics on fixtures at 8/44.1/48/96/192 kHz. Test silence, full-scale DC, alternating peaks, rapid topology switching and bypass. No stale memory pop or non-finite sample is acceptable.

### Saturation and EQ

Choose a reproducible 2x polyphase FIR prototype first; a 65-tap design is a candidate, not a guarantee of stopband rejection. Verify passband/stopband before freezing tap count. Filter both interpolation and decimation, and align dry/wet latency before mixing. If the alias target fails, increase filter length or oversampling factor within measured CPU limits. Preserve ADAA's numerical handling of nearly equal inputs and drive transitions.

Tube: bounded asymmetric transfer with DC removal. Tape: separate broad 55 Hz head-response candidate and level-dependent HF damping; state the chosen speed/response rather than implying a complete tape machine. Transformer: leaky integrated/low-frequency flux proxy with bounded nonlinear contribution and DC stabilization. Linear complementary paths must remain gain-correct; no single integral or static tanh establishes hysteresis.

For EQ, retain explicit band controls. A Pultec-inspired contour can be a transparent shelf-plus-bell preset; do not invisibly change damping when another band moves. Do not multiply the prewarp term by an unverified Nyquist factor. Any new shelf method needs a specified analog/reference response and measured gain/frequency behavior across rates.

Tests: coherent sine and multitone spectra, 20 Hz–20 kHz where rate permits; unity/no-drive delayed null ≤1e-6; DC after settling below −90 dBFS; desired EQ response within 0.25 dB over the documented passband; filter passband ripple ≤0.1 dB and measured stopband ≥60 dB. Define alias masks separately from wanted harmonics: target unwanted foldback below −75 dBFS on declared nominal-drive fixtures, and publish worst-case hot-drive results. Include amplitude-matched comparisons and deterministic transition tests. Do not declare every possible input alias-free.

### LR4 stereo

For both Mid and Side, cascade two second-order Butterworth low-pass sections and two high-pass sections at the actual requested crossover, Q=1/sqrt(2). Let `A(x)=LP4(x)+HP4(x)`. Output Mid=`midGain*A(M)` and Side=`sideGain*width*(lowAmount*LP4(S)+HP4(S))`, with lowAmount=0 for mono bass and 1 otherwise. Maintain the same all-pass Mid path in both cases. Width zero makes Side zero. Apply all-pass compensation before any parallel mix. Transition crossovers using parallel old/new state and a bounded crossfade, not abrupt coefficient changes.

Tests: each branch −6.02 dB at crossover within 0.1 dB; reconstructed magnitude within 0.1 dB; aligned branch phase within 1 degree at crossover; width=0 L/R null ≤1e-6; mid unchanged except specified all-pass/gain; measured side attenuation follows LR4 below crossover. Do not demand all signals below crossover become perfectly mono at the crossover itself: the high-pass remains −6 dB there.

### Lookahead limiter

Set nominal lookahead to 2 ms at preparation: `ceil(fs*0.002)`. Use an indexed stereo peak detector with its FIR group delay explicitly accounted for. Schedule a conservative gain envelope over the delay window; attack smoothing must never lift gain above the bound needed by an upcoming peak. A bounded direct scan is acceptable for the first correct reference implementation, followed by a fixed-capacity monotonic queue if benchmarks justify it. Use separate transient and sustained release states. Post-gain reconstruction peaks need independent validation and a measured safety margin. No production clipping fallback may be disguised as transparent limiting.

Tests: independent high-resolution offline true-peak oracle, phase-swept high-frequency sines, impulses, two-tone bursts, hot bass, alternating full scale, DC, final-sample peaks and long silence. Acceptance target ≤ceiling+0.05 dBTP on the declared corpus, no dropped tail, exact reported latency and frame length. Run an independent BS.1770 conformance corpus; a self-comparison with the same FIR cannot certify accuracy. Dither/resampling must be tested at final output. Test limiter bypass and reset during sustained reduction.

## 5. Measured analysis, reference matching and script contract

Keep expensive structure/spectral analysis separate from `MeasureStereoContext`. Run `AnalyzeSpectrumAndStructureContext` in the bounded job system, not the audio callback. Aggregate normalized Hann-window FFT powers over 1 s windows at 250 ms hops. A 4096-point FFT is not a one-second window at 48 kHz: aggregate short FFT frames, reuse scratch and retain feature summaries rather than a full spectrogram. Weight source/reference bins using common physical frequencies and normalize bandwidth explicitly. Mark bands beyond usable Nyquist unavailable, not silent.

Normalize RMS, centroid and Side/Mid novelty terms by robust dispersion before summing; raw Hz and dB differences are not comparable. Select significant local peaks with 8 s minimum separation on sufficiently long tracks. Allow no internal boundary. Silence and very short files receive one neutral section. Label boundaries `Section 1…N`; optional role hints carry confidence and are editable.

Define source identity from canonical PCM bytes plus sample rate/channel/frame layout. Proposed Go types, serialized with matching lower-camel-case JSON tags:

```go
type SourceIdentity struct {
    PCMHash string `json:"pcmHash"`
    SampleRate int `json:"sampleRate"`
    Frames int64 `json:"frames"`
}
type SpectrumBand struct {
    LowHz float64 `json:"lowHz"`
    HighHz float64 `json:"highHz"`
    PowerDB float64 `json:"powerDb"`
    Valid bool `json:"valid"`
}
type FeatureFrame struct {
    CenterFrame int64 `json:"centerFrame"`
    RMSDB float64 `json:"rmsDb"`
    CentroidHz float64 `json:"centroidHz"`
    SideMidDB float64 `json:"sideMidDb"`
    CrestDB float64 `json:"crestDb"`
}
type AnalysisFeatures struct {
    Version string `json:"version"`
    Source SourceIdentity `json:"source"`
    Bands [5]SpectrumBand `json:"bands"`
    SibilanceCrestDB float64 `json:"sibilanceCrestDb"`
    WindowCrestPercentiles [3]float64 `json:"windowCrestPercentiles"`
    Frames []FeatureFrame `json:"frames"`
    Warnings []string `json:"warnings"`
}
type SectionV2 struct {
    ID string `json:"id"`
    Name string `json:"name"`
    StartFrame int64 `json:"startFrame"`
    EndFrame int64 `json:"endFrame"`
    RoleHint string `json:"roleHint"`
    Confidence float64 `json:"confidence"`
}
type AutomationPoint struct {
    Frame int64 `json:"frame"`
    Value float64 `json:"value"`
}
type AutomationMoveV2 struct {
    ID string `json:"id"`
    SectionID string `json:"sectionId"`
    Reason string `json:"reason"`
    Target string `json:"target"`
    Operation string `json:"operation"`
    Points []AutomationPoint `json:"points"`
    FadeFrames int `json:"fadeFrames"`
    Muted bool `json:"muted"`
}
type ScriptV2 struct {
    Version string `json:"version"` // "2.0"
    Source SourceIdentity `json:"source"`
    Revision uint64 `json:"revision"`
    Profile ProfileID `json:"profile"`
    ChainParams dsp.Params `json:"chainParams"`
    Sections []SectionV2 `json:"sections"`
    Moves []AutomationMoveV2 `json:"moves"`
    Findings []Finding `json:"findings"`
    BeforeMetrics dsp.Metrics `json:"beforeMetrics"`
}
```

Targets use a closed allowlist: input gain, five EQ gains, compressor threshold/ratio, saturation amount, stereo width and independently validated repair amounts. No arbitrary object-path evaluation. Initial v2 permits one active move per target/time interval; reject overlapping intervals rather than relying on array order. Operation is `absolute` or `add`, evaluated against the immutable baseline once. Section intervals partition the source. Points use source sample frames, not browser wall time. Require at least two points; the first and last define the half-open active interval, fully inside the referenced section. Adjacent intervals may touch without overlapping. FadeFrames must be nonnegative and at most the smaller of half the interval and 100 ms at source rate. Server-owned range metadata overrides any client hints.

Automation does not implicitly enable a disabled module. An analysis proposal that needs a module must visibly enable it in its proposed baseline; applying that baseline is an explicit operation. A manually authored move targeting a disabled module remains inaudible until the user enables it. Test this behavior for every module, including repair; do not inherit v1’s inconsistent implicit repair enable rule.

Enforce exact version, unique IDs, source hash/rate/frame binding, valid section references, finite values, ordered points, duration bounds and 128 moves/256 points per move caps. Preserve v1 decoding/rendering as a separate legacy path. Current profile names remain Warm Analog, Punchy Commercial, Dynamic & Open, Vocal Forward and Bass Heavy; legacy aliases retain their mapping. Do not silently reinterpret `metal_wall` or `pop_punk_air`.

| API change | Contract |
| --- | --- |
| Existing `POST /api/analyze/deep` | Add validated `scriptVersion=2.0` and bounded options. Return existing 202 job envelope. Poll GET and explicitly DELETE to cancel an admitted job; fetch abort alone is insufficient. |
| Existing `POST /api/master/render` | Add bounded `script` multipart field, mutually exclusive with `params`/`profile`. Verify identity/version before rendering via common script evaluator. |
| New `POST /api/analyze/reference` | Canonical source/reference WAV parts and bounded amount/protectBelowHz/includeWidth options. Return measured spectra, proposed params, fit residual and warnings through the same job system. |

Memory reservation must include both decoded signals, FFT scratch, feature storage, proposals and output. Existing limits include 256 MiB job reservations, 64 retained records, up to four workers, two-minute timeout and 15-minute terminal retention; serialized expensive-request admission remains. Two individually valid maximum-size uploads are not automatically admissible together. No raw upload persistence or user filenames on disk.

### Decisions from measurements

Use measured relative spectral balance to propose conservative corrections, initially bounded to ±3 dB. Fit the actual five-filter frequency response against the spectral delta with regularization: five band-energy differences are not five independent EQ gains. Simulate candidate compression and measure its reduction before accepting threshold/ratio. Low crest prompts an uncertainty-qualified recommendation, not automatic transient “restoration.” Do not always lift the loudest section; local headroom and existing dynamics may call for less processing.

Reference matching uses canonical reference audio, not its saved knob positions. Normalize overall level before tonal comparison. Restrict comparison to common valid bandwidth; display residual mismatch. Protect Low End constrains predicted and remeasured response below 120 Hz, initially within 0.25 dB, rather than merely freezing two knobs. Match amount zero is exact identity; apply from a snapshot so repeated Apply and amount changes do not accumulate. Width changes remain opt-in and correlation-checked. LUFS targets remain explicit user choices; report infeasible targets and measured final output instead of adding hidden gain.

### Shared live/export automation

Compile scripts off the audio thread into fixed-capacity typed arrays. Add a separately versioned schedule ABI instead of squeezing timeline points into the static control vector. Use one Go evaluator in native and WASI. Publish complete schedules atomically with revision acknowledgment; release retired buffers outside processing. UI edits invalidate old analysis/after-metrics and pending results. A baseline Advanced edit updates `script.ChainParams` while retaining moves; provide an explicit Detach automation action to return to static processing.

Do not call full `SetParams` with coefficient recomputation each sample. Gain targets may interpolate per sample; expensive filter coefficients need a bounded scheduler and stable parameter smoothing with quantified error. Exclude continuous topology/boolean automation in v2's first version. Seeking reconstructs envelopes from the source-frame clock; repeat wraps deterministically; cross-rate playback maps source time explicitly. Muted moves give baseline; solo is an audition mask and must be visibly identified if included in export. Review/apply is separate from analysis, so a late job cannot overwrite current edits.

Acceptance targets: synthetic transitions localized within 250 ms; constant signal/silence produces no fabricated sections; exact section coverage; spectral-band energy within 0.5 dB on known tones/noise away from boundaries; same-reference tonal correction within 0.1 dB; amount-zero identity; protected-bass response within 0.25 dB; bounded reference-fit residual improves on known broad-EQ fixtures. Test different rates, short files, silence, unavailable high bands, cancellation and memory admission. Native/WASI automation must match at equal rates and block partitions; each move changes only its intended interval with fade allowances. Capture live PCM and downloaded PCM, not just animated controls.

## 6. Progressive UI and canonical presets

Existing validated controls remain. Add EQ type/individual band enable and limiter release using shared primitives first. Topology, true-peak and repair controls are gated on real DSP behavior: `browser-engine.ts:engineParams` currently hardcodes Optical and rejects enabled repair/true-peak requests. Removing those guards alone does not implement a feature. Legacy declick/phase-align booleans remain unsupported; do not relabel them as other repair functions.

Proposed additive TypeScript declarations:

```ts
type CompressorTopology = "optical" | "vari_mu" | "fet" | "vca";
type SimpleStyle = "precise" | "organic" | "elevated";
type SimpleDirection = {
  version: 2;
  genre: "Pop" | "Hip-hop" | "Rock" | "Electronic" |
    "Acoustic" | "R&B" | "Metal" | "Jazz";
  tone: "Warm" | "Open" | "Punchy" | "Intimate" | "Wide" | "Clean";
  style: SimpleStyle;
  depth: boolean;
  presence: boolean;
  intensity: number;
};
// Extend existing CompressorParams with topology: CompressorTopology.
// Extend AdvancedParams with algorithmVersion: 1 | 2.
// Extend RepairParams with deEssDb: number and transientDb: number.
// Extend Track with optional simpleDirection, sourceIdentity,
// masteringScript and analysisRevision using the generated Go schema.
```

Hydration supplies neutral metadata without recomputing `track.advanced`. Mode changes remain view-only. Explicit Simple choices compose one fresh bounded chain, preserve the current limiter target, and apply Depth/Presence once. Their order must commute. Advanced edits clear the Simple association; do not delete the user's last suggested direction. Existing starting-point highlights continue deriving from matching canonical values.

Style behavior is an Aurialis design proposal, not extracted Waves coefficients: Precise keeps conservative corrective moves; Organic reduces compression/drive; Elevated permits more density only within measured headroom and the explicit loudness target. Keep current conservative genre priors while calibrating Metal/Jazz on varied material. Listening comparisons should be level-controlled during engineering evaluation even if the product transport retains the requested simple A/B interface. No commercial quality claim follows from merely matching macro names.

Deep displays diagnostics, confidence, proposed baseline and editable lanes with Analyze, Cancel, Apply and Revert. Reference displays measured curves and proposed deltas. Reuse SliderField, SegmentedControl, DSPModule, SpectrumChart and timeline primitives; warm editorial tokens, inline SVG, mobile bottom sheets and desktop inspector remain canonical. Reserve status space. Every drag value has a numeric/keyboard equivalent and default reset; every target remains at least 44 px.

Frontend acceptance: all genre/tone/style/modifier combinations finite and bounded; zero intensity neutral except explicit limiter choice; target-only updates preserve manual edits; legacy projects preserve PCM; mode/reload retains settings; failed/cancelled/stale jobs never overwrite edits; scripts persist and play after navigation; A/B, seek, repeat and external media controls remain functional. Run six widths 320/375/390/768/1024/1440 with axe, no horizontal overflow, keyboard and touch checks. Every new meaningful control must independently affect exported and live PCM.

## 7. Implementation order and release gates

1. Freeze legacy fixtures and add behavior-version/capability/latency contracts, including startup/tail and A/B tests.
2. Implement one compressor topology at a time with transfer/ballistics tests; expose generic selectors only when useful distinctions pass.
3. Implement oversampling and separate coloration state, then LR4; validate bypass/phase/alias behavior and CPU budgets before retuning presets.
4. Implement lookahead limiting and independent reconstructed-output verification; only then expose true-peak controls and labels.
5. Add standalone feature analysis and neutral segmentation with bounded jobs.
6. Add typed script validation, common evaluator, render route and live schedule ABI; then Deep UI.
7. Add measured reference matching and response protection; then calibrate Simple styles/Metal/Jazz and optional modifiers.

Each slice needs small commits, Technical Writer sync, QA and Devil's Advocate review and the applicable AGENTS.md gates. Preserve frozen v1 PCM exactly. Test v2 parity across native, offline JS/WASM and live WASI, allocation-free warmed ProcessBlock with all stages at block sizes 1/127/128/129/4096 and rates 8/44.1/48/96/192 kHz. Measure worst-case render deadlines and actual long-file audio continuity rather than treating zero allocation as real-time proof. Run Go format/modules/vet/lint/identifier/vulnerability/race gates and both WASM builds for DSP changes; TS/lint/knip/spelling/unit/build, full Playwright, Newman and standalone binary smoke for vertical slices. Update expected output baselines only with documented intentional algorithm-version differences.

Specification review is not implementation acceptance. Hardware-equivalence, alias-free, universal true-peak and trained-AI claims remain unsupported without the corresponding evidence. The blueprint's aggressive matrix and equations are candidates to test, not acceptance evidence.

## 8. Primary sources and what they establish

- [Waves getting-started guide](https://www.waves.com/support/waves-online-mastering-getting-started): three styles, combinable Depth/Presence, reference workflow and optional volume matching. Establishes workflow, not proprietary algorithms or preset coefficients.
- [Waves mastering FAQ](https://www.waves.com/online-mastering/faq): product controls and loudness workflow. Does not establish a universal −7 to −9 LUFS target or static-only internal processing.
- [Universal Audio LA-2A guidance](https://www.uaudio.com/blogs/ua/la-2a-collection-tips-tricks): program-dependent release and model variation. Does not validate the proposed state equations as a circuit model.
- [Universal Audio 2-1176 manual](https://media.uaudio.com/assetlibrary/2/-/2-1176_manual.pdf): reference attack/release ranges; a quarter of 10 ms is still outside its documented sub-millisecond attack range.
- [Waves SSL compressor manual](https://www.waves.com/1lib/pdf/plugins/ssl-g-master-buss-compressor.pdf): attack/release/sidechain control behavior; no license to infer exact hidden detector equations.
- [Rane LR crossover primer](https://www.ranecommercial.com/legacy/note160.html): branch alignment and flat summed magnitude with phase rotation.
- [FabFilter lookahead guidance](https://www.fabfilter.com/help/pro-l/using/advancedsettings) and [oversampling guidance](https://prod.fabfilter.com/help/pro-l/using/oversampling): distortion/transient/CPU/filtering tradeoffs, not reusable limiter algorithms.
- [ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I): current in-force measurement recommendation found in this research. The repo's BS.1770-4 compatibility claims require their own conformance evidence; do not silently rename them.
- [Universal Audio ATR-102 description](https://www.uaudio.com/products/ampex-atr-102): commercial modeling includes multiple tape/circuit paths. A head-response bell and waveshaper are a smaller approximation.

Research roles: DSP/audio audit, Deep/backend audit and frontend/workflow audit independently inspected the current sources. No implementation or new acoustic test result is claimed by this document.
