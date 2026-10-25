# Mastering tools audit against pro plugin behavior

Date: 2026-10-24. Scope: `main` at `ad544d7`, plus open drafts PR #20 (true-peak limiter, algorithm 2) and PR #21 (FLAC/MP3 import). The unmerged album-consistency branch was checked only where it touches render and loudness.

Method: a Go measurement harness drove `dsp.Engine` with sines, two-tones, bursts and level steps at 44.1, 48, 96 and 192 kHz. It also used a 32x windowed-sinc true-peak reference and WAV encode/decode round trips. The war room DSP plugin engineer reproduced the DSP numbers independently, and the devil's advocate checked the source citations and the ledger for duplicates. The reference behavior comes from FabFilter Pro-Q/Pro-C/Pro-L/Pro-DS, Waves L-series and Ozone conventions, ITU-R BS.1770-4 and EBU Tech 3341. No application code was changed.

Severity: **P0** blocks a beta, **P1** falls below the pro bar, **P2** is a labelling or quality gap, **Low** is cosmetic.

## Ranked findings

| # | Sev | Tool | Result | Evidence | Pro standard | Already tracked |
|---|---|---|---|---|---|---|
| 1 | P0 | Limiter (every UI path) | **FAIL** | With a -1 dBTP ceiling, an fs/4 sine came out at **0.00 dBTP** on the 32x reference, 1 dB over. The UI forces `truePeak:false` (`src/lib/engine-params.ts:4,56`) and labels the control "Sample-peak limiter". The Simple "Loud" target uses a **-0.2 dBFS sample-peak** ceiling (`src/lib/audio-dsp.ts:268-269`), so it ships intersample overs. PR #20's v2 holds **-1.24 dBTP** and cuts 100 Hz THD from -35.7 to -64.7 dB. However, PR #20 still rejects algorithm 2 in `live-controls.ts:29-30` and `deep-mastering.ts:88`, and pins v1 in `proposal_v2.go:31` and `wasm/dsp/live_contract.go`. Only a raw API call reaches it. | Pro-L, L2 and the Ozone Maximizer hold the dBTP ceiling with oversampled lookahead. | TP-1 (PR #20), MUB-4B (UI deferred). The missing UI/Deep wiring is new. |
| 2 | P1 | Live metering | **FAIL** | Playback shows only sample peak, RMS and crest (`AurialisWorkstation.tsx:934-955`). The worklet computes correlation but nothing displays it. There is no live momentary, short-term or integrated LUFS, no true peak and no GR meter. LRA does not exist anywhere. | Ozone, Pro-L and Waves WLM show live M/S/I LUFS, dBTP, LRA and GR. | New |
| 3 | P1 | WAV/AIFF import | **FAIL** | `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) is rejected (`internal/audio/cdr.go:262`). Pro Tools, Logic and Reaper write that tag for 24-bit and above-48 kHz files. 24-bit AIFF is rejected because only 16-bit is accepted (`cdr.go:429`). PR #21 does not change either. | Every DAW and plugin host reads both. | New |
| 4 | P1 | Saturation, all characters except Transformer | **FAIL** | **HF loss** at amount 50 relative to 1 kHz: Warm -2.4 dB at 16k and -3.2 at 20k. Tube/Tape -3.5 and -5.0. Thick/Crisp -5.1/-5.3 and -8.6/-9.2. Even Tube at amount 10 loses -0.7 dB at 16k. The cause is the two-point decimator (`engine.go:1063`). **Small-signal gain** on Thick/Crisp is +5.2/+6.7 dB at amount 50 and +12.4/+15.5 dB at amount 100, so turning up drive mostly makes the track louder. **Aliasing** from 10-15 kHz content is -27 to -37 dBc. | Saturn and the Ozone Exciter stay flat within about 0.1 dB and alias below -70 dB. | Aliasing is MUB-2C. The HF loss and gain jump are new. |
| 5 | P1 | Loudness-matched A/B | **Decision** | Live A/B is an unmatched dry/wet crossfade. The engine's `LoudnessMatchAB` has no UI, and its 42 ms unweighted RMS tracker partly undoes dynamics: a 20 dB burst pair measured 2.25 dB unmatched versus 6.05 dB matched. So louder B always "wins". | Ozone Gain Match and Pro-L's loudness-compensated monitoring match by LUFS. | MUB-4E was declined by the owner. It needs a fresh decision, not a fix. |
| 6 | P2 | De-esser (`repair.deEssDb`) | **FAIL** | The response is non-monotonic because the Q=2 bandpass is subtracted without normalization. On a 6.5 kHz tone at -12 dBFS: 2.4 dB → -5.7, 4.2 dB → -12.6, 6 dB → **-52.5 (null)**, 10 dB → -8.7 and phase-inverted. The current UI cannot reach it (`engine-params.ts:6`). The API `profile=` render path can (`mastering.go:116,177`; `server.go:517`), and so can legacy v1 script moves. | Pro-DS range is a hard cap on attenuation. | New |
| 7 | P2 | EQ shelves | **FAIL (label)** | The half-gain point sits at **1.85x** the label for the low shelf and **0.649x** for the high shelf, at every gain and Q (`engine.go:481,498`). The default "Low 250 Hz" shelf therefore acts at about 463 Hz, and "Air 12 kHz" at about 7.8 kHz. | Pro-Q and RBJ put the label at the shelf midpoint. | Predictor alignment was done before; the label convention is new. |
| 8 | P2 | EQ bell Q | **FAIL (label)** | Effective Q = set Q x (1 + 0.25·\|gain dB\|). That is 2.5x the shown Q at ±6 dB and 4x at ±12 dB, symmetric for boost and cut. | Pro-Q holds Q constant. Proportional Q is an API/Massive Passive choice and should be labelled as one. | New |
| 9 | P2 | Mono bass | **PASS (sound) / FAIL (label)** | A 110 Hz setting gives side -29 dB at 110, -12 at 160 and -3 dB at **242 Hz**, an 8th-order slope at 1.45x the label. The mono sum is preserved to 6e-8. | the Ozone stereo imaging module puts -3 or -6 dB at the stated frequency. | New |
| 10 | P2 | Multiband | **FAIL** | The split is first order (6 dB/oct). Cutting the low band by 12 dB gives -9.3 at 50 Hz, -2.8 at 200 Hz and -1.0 at 400 Hz. A low band with 5 ms attack on 60 Hz gives H3 of -34.7 dBc. It does reconstruct perfectly when idle. | Ozone and Pro-MB use 24-48 dB/oct LR or linear phase. | MUB-2C (LR4), ledger limits section |
| 11 | P2 | Compressor ballistics | **PASS (curve) / label** | The static curve is exact: 7.49 vs 7.50 dB and 14.99 vs 15.00 dB of GR. The attack and release labels are the 91.8 % settling time, so the 63 % time constant is 0.4x the label: 10 ms → 4.1 ms, and 200 ms release → 96 ms. The four topology labels are bit-identical; the UI hides them. | Most tools quote the 63 % time constant. | Topologies are MUB-2B; the timing definition is new. |
| 12 | P2 | Limiter distortion on main | **FAIL** | A 50 Hz tone driven 6 dB over gives -30.6 dB THD, and 100 Hz gives -35.7 dB. PR #20 improves these to -41.9 and -64.7 dB. | Lookahead limiters stay below about -50 dB at moderate GR. | MUB-2D / TP-1 |
| 13 | P2 | Export options | **Gap** | Export is WAV only, with no sample-rate conversion (a CD profile only warns) and TPDF dither only, with no noise shaping or dither-off choice. | Ozone and Waves offer SRC, noise-shaped dither and MP3/FLAC export. | New |
| 14 | Low | WAV scaling and dither grid | **Minor** | Decoding divides by 32768 and encoding multiplies by 32767 (`cdr.go:560,565`). Samples above half scale shift by 1 LSB (about -111 dBFS at 16-bit), so bypass is not strictly bit-transparent. The post-dither limiter re-clamp (`engine.go:829-840`) can move samples off the dither grid. Several common audio libraries use the same convention. | Bit-transparent null on bypass. | New |
| 15 | Low | Simple targets | **Minor** | "Dynamic" and "Podcast" are identical (-16 LUFS, -1 dB) (`mastering-targets.ts:5-8`). | Not applicable | New |

## Passing tools (measured)

| Tool | Evidence |
|---|---|
| EQ bell centre gain and sample-rate invariance | Exactly ±6.00/±12.00 dB at 1 kHz; a 10 kHz bell reads +6.00 dB at 44.1, 96 and 192 kHz. |
| EQ high-pass | -3.01 dB at the set 30 Hz, with a 12 dB/oct slope. |
| De-Harsh | The range is exact: 3, 6 and 12 dB settings cut exactly 3.00, 6.00 and 12.00 dB. |
| Integrated loudness meter | 1 kHz sine at -20 dBFS peak per channel reads -19.98 LUFS (expected -20). The EBU 3341-style gating case (-36/-20/-36) reads -20.00. Correct at 44.1, 48 and 96 kHz. |
| True-peak meter (offline) | Reads 0.10 dB high on the fs/4 worst case, which is the safe side and inside the EBU 3341 tolerance. |
| Engine bypass, latency and A/B alignment | Bypass is bit-identical. Main has 0 frames of latency. Dry and wet share one playback delay, so A/B stays time-aligned. |
| Live versus export | Same Go engine. Tonal and dynamics results match within 0.01 dB (saturation harmonics) and 0.06 dB (compressor GR) between 44.1 and 48 kHz. Only alias placement differs. |
| FLAC/MP3 import (PR #21) | MP3 gap-free length and alignment, and an ffmpeg oracle at 1e-5, are covered by the PR's tests. Not re-run here. |

## Suggested fix order for the war-room loop

1. Wire algorithm 2 into live, export and Deep, make the "Loud" target true-peak safe, and relabel the limiter. This builds on PR #20 rather than duplicating it.
2. Add live LUFS (M/S/I), dBTP and GR meters, and show the correlation the worklet already computes.
3. Accept `WAVE_FORMAT_EXTENSIBLE` and 24-bit AIFF in the Go CDR. This is stdlib-only and fits beside PR #21.
4. Fix saturation HF loss and Thick/Crisp gain with a proper half-band decimator and gain normalization, then address aliasing under MUB-2C.
5. Normalize the de-esser bandpass (a one-line fix), and relabel the shelf frequency, bell Q, mono-bass frequency and compressor times, or move them to the pro conventions.
6. Owner decision: loudness-matched A/B (MUB-4E).

The measurement harness is kept outside the repo and can become regression tests for each fix.
