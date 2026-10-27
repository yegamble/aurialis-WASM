# Advanced mastering controls and preset calibration

Research date: 2026-10-21. Implementation is locally verified at the bounded scope recorded in tasks; remote CI and merge remain pending.

## Reference workflows

Waves' public documentation describes useful mastering workflows, but does not publish the proprietary algorithms or complete genre recipes used by its online mastering service. Aurialis implements its own processing and presets. No sonic equivalence to Waves products or named hardware is claimed.

- [SSL G-Master Buss Compressor manual](https://www.waves.com/1lib/pdf/plugins/ssl-g-master-buss-compressor.pdf): detector high-pass filtering, makeup gain, selectable attack and release, and automatic release that depends on peak duration. Detector filtering changes compression sensitivity; it does not directly remove bass from the output.
- [Waves SSL bus compression guide](https://www.waves.com/how-to-use-ssl-bus-compressor-classic-mix-glue): gentle mastering compression and adapting release to the musical envelope inform the conservative starting points. A fixed threshold cannot guarantee a particular gain reduction on every mix.
- [F6 Dynamic EQ](https://www.waves.com/plugins/f6-floating-band-dynamic-eq): frequency-selective attenuation triggered by signal level motivates an adjustable de-harsh stage. This is distinct from permanently reducing the entire treble range.
- [Linear Phase Multiband Compressor](https://www.waves.com/plugins/linear-phase-multiband-compressor): independently controlled frequency bands and crossover placement inform the multiband workflow. Aurialis must document its own crossover implementation; referencing this product does not make our filters linear phase.
- [Kramer Master Tape](https://www.waves.com/plugins/kramer-master-tape): different harmonic and frequency-dependent behavior motivates separate saturation choices. Aurialis' Tube, Tape and Transformer are original character models, not circuit replicas or licensed emulations.
- [Waves Online Mastering FAQ](https://www.waves.com/online-mastering/faq): style, tone and suitable references help guide a result. Its reference analysis and adaptive service cannot be reproduced by assigning fixed genre values. Aurialis' Simple controls remain explicit, editable starting points.

## Implementation contract

Advanced and Simple share one parameter state. Choosing a Simple direction replaces that state with its calibrated starting point while preserving the selected loudness target. Editing Advanced clears the Simple selection. Switching views never changes audio settings.

Expose existing compressor makeup, knee and detector high-pass parameters. Add automatic release, adjustable mono-bass crossover, independent mid/side gain, optional de-harsh and optional three-band compression. New stages remain disabled when restoring older projects. Preserve legacy saturation characters for existing projects; Clean performs no saturation and disables its drive control.

Glue, Add Air, Cut Mud and Tape Warmth are explicit setting shortcuts. Repeating a shortcut must not accumulate gain. Their resulting values remain visible and editable. A highlighted button means its relevant settings currently match, including source-rate-limited frequencies. Several shortcuts can match at once. Editing or bypassing those settings clears the corresponding highlight; unrelated edits leave it in place. Clicking an active shortcut restores the settings it replaced, limited to its own affected parameters. Other shortcuts and unrelated manual edits remain intact. Saved restoration data survives reload; an already matching legacy setting without restoration data turns off to neutral settings for that shortcut. Every draggable control retains double-click and keyboard reset behavior.

New genre presets use modest tonal shifts, compression ratios, saturation and width. Intensity scales processing strength, rather than adding an unexplained fixed amount of distortion at zero. No preset silently changes the user's output target or claims automatic loudness normalization. De-harsh and multiband require explicit user selection because a genre label alone cannot establish that a mix needs corrective processing.

## Required evidence

- Independent signal tests for each new parameter, including bypass, silence, sample-rate limits and finite output.
- Unity reconstruction and band-selective dynamics tests for multiband; selective attenuation tests for de-harsh.
- Native, legacy WASM and live WASI parity through the actual parameter encoder.
- No processing-time allocation or host calls introduced into the live render path.
- Persisted older projects retain their previous sound; all new fields survive reload.
- Actual browser controls change exported PCM and live output, without mode-switch or playback regressions.
- Responsive, keyboard and accessibility gates, documentation sync, and adversarial review before merge.

## Deep proposal baselines

Deep's measured proposal starts from one of five baselines (`internal/mastering/starting_points.go`) on the same conservative scale as the Simple presets. Each has one signature EQ move of at least 1 dB that matches its name, checked against the actual filter response (`TestProfileSignaturesMatchTheirNames`). Every limiter ceiling is −1 dBTP. Compression uses a 6 dB knee with automatic release off, so the listed release is the one applied. The threshold is not fixed: analysis searches for the threshold that gives the listed average gain reduction on this source (frames whose detector reads above −60 dBFS). The measured spectral fit may then move each EQ band by up to ±3 dB from these values.

| Profile | EQ (signature in bold) | Compressor | Average reduction | Ratio | Attack / release ms | Detector HPF Hz | Saturation | Width % | Mono bass |
| --- | --- | --- | ---: | ---: | --- | ---: | --- | ---: | --- |
| Warm Analog | 0.5 / **1.1** / 0 / −0.4 / −0.8 | Optical | 1.5 dB | 1.7 | 30 / 250 | 90 | Tube 8% | 100 | Off |
| Punchy Commercial | 0.6 / −0.8 / 0 / **1.2** / 0.5 | VCA | 1.5 dB | 2 | 30 / 150 | 90 | Transformer 4% | 104 | 110 Hz |
| Dynamic & Open | 0.2 / −0.3 / 0 / 0.2 / **1.2** | Optical | 0.75 dB | 1.4 | 40 / 300 | 60 | Clean (off) | 104 | Off |
| Vocal Forward | 0 / −0.6 / **1.2 at 2 kHz** / 0.3 / 0.3 | Optical | 1.5 dB | 1.7 | 30 / 200 | 100 | Tube 3% | 100 | 110 Hz |
| Bass Heavy | **1.5 shelf at 90 Hz** / −0.6 / 0 / 0 / 0.2 | VCA | 1.5 dB | 1.8 | 30 / 200 | 120 | Tape 4% | 102 | 110 Hz |

EQ columns are Sub / Low 250 Hz / Mid / Presence 4 kHz / Air 12 kHz shelf in dB; Sub is a 60 Hz shelf unless noted and Mid is 1 kHz unless noted. Measured signatures: Warm Analog +1.1 dB at 250 Hz and the darkest top (−0.8 dB at 12 kHz); Punchy Commercial +1.2 dB at 4 kHz; Dynamic & Open +1.2 dB at 12 kHz; Vocal Forward +1.25 dB at 2 kHz; Bass Heavy +1.5 dB at 40 Hz, +1.16 dB at 120 Hz and −0.47 dB at 250 Hz. Each exceeds every other profile by at least 0.5 dB at its signature frequency.

**Level match.** The baseline adds no hidden loudness: no input gain and no makeup of its own. After the proposal is rendered through the export limiter, the measured loudness shortfall becomes one explicit **Level match** gain, set as compressor makeup in 0.1 dB steps. Round E ruling: the Level match may push into the export limiter, but a positive gain never makes its predicted peak reduction exceed 2 dB (half the 4 dB heavy-limiting finding) and never exceeds +12 dB; the −1 dBTP ceiling is held by the limiter itself. Up to three more export renders (a secant step that learns how much loudness each dB buys once the limiter engages) stop within 0.1 LU of the source or at the cap, and the last render of the chosen gain is the prediction. When the 2 dB cap leaves the proposal more than 1 LU quieter, the loudness-drop finding says that holding the source loudness would need more than 2 dB of limiting and to raise the level by hand only if the extra limiting sounds clean. Measured on two synthetic 6 s, 48 kHz fixtures (`TestDeepProfilesPredictExportLevelsAndExplainLargeChanges`):

| Profile | Dynamic: Δ LUFS / Δ crest / TP / avg GR / limiter GR / Level match | Dense: Δ LUFS / Δ crest / TP / avg GR / limiter GR / Level match |
| --- | --- | --- |
| Warm Analog | −0.04 LU / +0.27 dB / −10.13 dBTP / 1.50 dB / 0.00 dB / +1.2 dB | −0.02 / −0.37 / −1.22 / 1.48 / 1.84 / +1.5 |
| Punchy Commercial | −0.02 / +0.36 / −9.79 / 1.45 / 0.00 / +2.1 | −0.09 / −0.54 / −1.23 / 1.50 / 1.91 / +2.4 |
| Dynamic & Open | −0.03 / +0.25 / −9.93 / 0.75 / 0.00 / +1.1 | −0.01 / −0.61 / −1.23 / 0.74 / 1.42 / +1.3 |
| Vocal Forward | −0.01 / +0.40 / −9.84 / 1.49 / 0.00 / +2.3 | −0.16 / −0.35 / −1.22 / 1.47 / 1.91 / +2.4 (cap) |
| Bass Heavy | +0.02 / +0.33 / −9.63 / 1.50 / 0.00 / +1.6 | −0.30 / −0.45 / −1.22 / 1.51 / 1.95 / +1.7 (cap) |

Dense sources now hold loudness within 0.3 LU at the cost of 1.4–2.0 dB of peak limiting and a 0.35–0.61 dB crest cut; before the ruling the true-peak headroom cap left them 1.0–1.7 LU quieter with 0.1–0.5 dB of limiting. Dynamic sources are unchanged. On a clipped, square-like 2 s source (`TestLevelMatchReportsTheLimitingCap`) the cap binds at +0.1 dB with 1.99 dB of limiting, the proposal is 1.36 LU quieter and the drop finding explains why.

Generated section moves are capped (MUB-5) at +0.8 dB EQ, +8 width points and +0.5 dB saturation drive above the baseline; cuts are not capped. The generator currently emits only −0.5 dB input-gain headroom trims, so these caps guard future EQ, width and drive moves. A finding explains a loudness change above 1 LU, a crest cut above 4 dB or an export limiter peak reduction above 4 dB.

The removed static profile cards (Modern Pop Polish, Hip-Hop Low-End, Indie Warmth, Metal Wall, Pop Punk Air) applied EQ moves that contradicted their own genres and ceilings up to −0.3 dBTP. Simple and Deep cover those starting points.

## Simple preset reference

The following values describe **100% intensity** before adding the tone intention. EQ columns are Sub 60 Hz / Low 250 Hz / Mid 1 kHz / Presence 4 kHz / Air 12 kHz, in dB. The Low band is a broad bell (Q 0.7); Sub and Air are shelves.

| Genre | EQ | Threshold dB | Ratio | Attack / retained manual release ms | Detector HPF Hz | Drive % | Width % | Mono bass |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| Pop | 0.2 / −0.3 / 0 / 0.2 / 0.5 | −16 | 1.8 | 30 / 200 | 90 | 2 | 104 | Off |
| Hip-hop | 0.6 / −0.4 / 0 / 0.3 / 0.1 | −16 | 1.8 | 30 / 200 | 120 | 3 | 102 | 110 Hz |
| Rock | 0.2 / −0.5 / 0 / 0.4 / 0.2 | −16 | 2 | 30 / 150 | 90 | 4 | 104 | Off |
| Electronic | 0.5 / −0.4 / 0 / 0.1 / 0.6 | −15 | 2 | 25 / 150 | 120 | 3 | 106 | 110 Hz |
| Acoustic | 0 / −0.2 / 0.2 / 0 / 0.3 | −14 | 1.5 | 40 / 300 | 60 | 0 | 100 | Off |
| R&B | 0.4 / 0.2 / 0.1 / −0.2 / 0.3 | −17 | 1.7 | 30 / 250 | 100 | 3 | 102 | 110 Hz |

| Tone | Additional EQ dB | Ratio adjustment | Additional drive points | Additional width points | Saturation |
| --- | --- | ---: | ---: | ---: | --- |
| Warm | 0.3 / 0.5 / 0 / −0.4 / 0 | 0 | 5 | 0 | Tube |
| Open | 0 / −0.4 / 0 / 0.3 / 0.9 | −0.2 | 0 | 4 | Tube |
| Punchy | 0.4 / −0.3 / 0 / 0.4 / 0.1 | 0.2 | 2 | 0 | Transformer |
| Intimate | 0 / 0.3 / 0.5 / 0 / −0.3 | −0.1 | 3 | −6 | Tube |
| Wide | 0 / 0 / 0 / 0 / 0.2 | −0.1 | 0 | 12 | Tape |
| Clean | 0 / 0 / 0 / 0 / 0 | −0.3 | Forces zero | 0 | Clean |

For intensity fraction `k`, EQ and drive multiply the combined values by `k`; ratio interpolates from 1:1, width from 100%, and threshold from −6 dB toward the genre threshold. Numeric values round to two decimal places. Punchy uses 30 ms attack and 150 ms retained manual release. All presets select automatic release, so the manual release value applies only after turning Auto release off. Wide also enables 110 Hz mono bass. Mono bass is off at zero intensity; its frequency is not interpolated. Knee is 6 dB, makeup and mid/side gains are zero. De-harsh and multiband stay off.

Examples at 50%: Rock + Clean produces EQ `0.1 / −0.25 / 0 / 0.2 / 0.1`, threshold −11 dB, ratio 1.35:1, attack 30 ms, automatic release, 90 Hz detector filter, no saturation and width 102%. R&B + Clean produces EQ `0.2 / 0.1 / 0.05 / −0.1 / 0.15`, threshold −11.5 dB, ratio 1.2:1, 100 Hz detector filter, no saturation, width 101% and mono bass below 110 Hz.
