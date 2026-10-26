# Aurialis-WASM War-Room Ledger
<!-- cspell:words Embedder automator Turbopack yyosefgamble yosefgamble ENOENT -->

Source of truth for the **Aurialis-WASM** backlog across `/war-room` and `/war-room-loop` iterations. The Chair updates this file after every Round D ruling and every Round E verification pass. One row per item; never delete a row — move completed items to **Verified & Merged** with commit/PR and test evidence, or to **Declined** with the reason.

**Statuses**:
`open` · `in-progress (<branch>)` · `awaiting-tech-writer (<branch>)` · `open — awaiting merge (<branch/PR>)` · `implemented — open, awaiting merge (<branch/PR>)` · `verified (<commit/PR>, <evidence-tier>)` · `blocked (<prerequisite>)` · `declined (<reason>)`

**Evidence Tiers** (from `.claude/war-room/repo-map.md`):
`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`

---

## Export sample-rate conversion and dither — 2026-10-26

`open — awaiting merge (PR #28)`. Tiers: `unit` · `wasm-bridge` · `api-curl` · `playwright-a11y-responsive`. Audit finding 13 (P2): exports can convert to 44.1/48/88.2/96 kHz with a 120 dB windowed-sinc converter after mastering, and 16/24-bit dither can be TPDF or off. Round E catch-up at `8ed74a6`: with the limiter on, converted exports are true-peak limited again at the delivery rate (8× detector −1.243 to −1.244 dBTP, 32× reference −1.173 to −1.229 dBTP at a −1 dBTP ceiling, all 12 pairs, no clipped samples; before, +0.2 to +2.9 dBTP with clipping, reported by backend); exact-decimal `sampleRate`, fields only on the render endpoints, limits rejected before rendering, delivered `ditherBits` and gain reduction reported; aliases ≤ −120 dB asserted; native/WASM converted renders byte-identical (Go test and a 7-render compiled check in `pnpm run test:wasm`); shared `ChoiceGroup`; delivered true peak in the Export status line. Vitest 530/530 and the Go/WASM checks re-run by the tech writer; Playwright browser 14/14 and native 26/26 reported by frontend/QA. Remote CI passed only at PR head `ca2ddd3`; later commits have not been pushed. Noise-shaped dither and FLAC/MP3 export are not offered. Open: Release Check renders at the source rate only and its CD guidance does not point to Export conversion; album renders and saved masters stay at the source rate; 4× meter accuracy upgrade (it can over-read up to 0.21 dB on converted exports) needs its own ruling; native `/api/master/render` has no memory admission for conversion buffers.

- **ADVISORY** — `e2e/finite-playback.spec.ts:50` failed once in CI on PR #28 (run 40345818654, shard 2: speaker chunk time delta 0 instead of 128) and passed on rerun. Live-playback clock flake, unrelated to export. Follow-up: `open`.

## Faster Smart Split — 2026-10-26

`merged (PR #27, 2026-10-26; unit)`. Vectorized softmax/GELU and larger attention tiles cut one window's CPU time by about 42% (295 s → 170 s); batched frequency-axis transformers also landed, their separate effect unmeasured. Accuracy unchanged against PyTorch (85–90 dB SNR; Accelerate output differs from before by about 1 float32 ulp). Tier: `unit` (model-free batching tests) plus opt-in real-model parity. Open: idle-machine song timing, faster plain-Go kernels for non-Mac platforms.

## Smart Split with a trained model — 2026-10-25

`verified (PR #24, unit · api-curl · playwright-a11y-responsive)`; merged 2026-10-26. The `stem-model-v1` release asset is still to be published. Trained BS-RoFormer separation (Mega53 five-head subset, MIT) runs Smart Split in the desktop app, replacing the heuristic splitter; first-use model download is checksum-pinned. Tier: `unit`, `api-curl`. Open: plain-Go speed for non-Mac platforms, browser inference, quality beyond the single measured track.

## Distinct compressor types — 2026-10-25

`verified (PR #24, unit · wasm-bridge)`; merged 2026-10-26. MUB-2B and the topology part of MUB-4B, delivered in algorithm 1 in place (saved sessions change sound) instead of the earlier v2-only ruling, matching the saturation-fix precedent. Each type has its own detector, curve and release; Advanced exposes the choice. Tier: `unit` and `wasm-bridge`. Behavioral models only; no hardware certification.

## Bit-exact integer WAV and dither grid — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 14 (Low). Integer WAV round-trips bit-exactly and dithered output stays on its grid. Tier: `unit`.

## Steeper multiband crossovers — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 10 (P2) and the LR4 half of MUB-2C: three-band dynamics use LR4 crossovers, with idle bands summing to an all-pass. Tier: `unit` and `wasm-bridge`. Linear-phase multiband is not offered.

## De-esser range — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 6 (P2). The de-esser band is normalized, so its cut is monotonic and bounded by `deEssDb`. Tier: `unit`. The repair UI remains absent.

## Saturation highs and level — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 4 (P1), fixed in place in algorithm 1, so saved sessions change sound. Saturation now has unity gain at program level (−12 dBFS peaks), is flat to 20 kHz and keeps native/WASM bit parity. Algorithm-1 true peak on Punchy and Bass Heavy is 0.06–0.07 dB higher than main on the reference mix; exports use algorithm 2. Tier: `unit` and `wasm-bridge`. MUB-2C (designed polyphase oversampling with ≥60 dB stop-band) remains open; aliasing improved but is not certified.

## Pro-convention control readouts — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit findings 7, 8, 9 and 11 (P2). The slider readouts state each control in pro-plugin terms, and the processing is unchanged. Tiers: `unit` (Go response measurements plus Vitest). Changing the controls themselves to the pro conventions would alter saved projects and remains a separate decision.

## 24-bit WAV and AIFF imports — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 3 (P1). The CDR now accepts extensible WAV and 1–32-bit AIFF and uncompressed AIFF-C, with stdlib only. Tier: `unit` (FFmpeg oracle, 12 layouts). Multichannel (>2) input is still rejected.

## Live loudness meters — 2026-10-25

`merged (PR #23, 2026-10-25)`. Audit finding 2 (P1): no live LUFS, true peak, LRA or GR. Go `dsp.LoudnessMeter` (BS.1770-4 / EBU 3341 / EBU 3342, 0.05 LU histograms, zero allocations) runs on the reactor's processed output; the worklet posts a seven-value snapshot every 50 ms and the workstation shows it. Tiers: `unit`, `wasm-bridge`, `playwright-a11y-responsive`. Live-playback browser cases rely on CI, because the local headless AudioContext clock does not advance. Limits: integrated loudness and range reset on each playback start or seek, and the meter does not follow the B Original selection.

## MP3 and FLAC import — 2026-10-24

`merged (PR #21, 2026-10-24)`. Go CDR decodes FLAC (stdlib) and MP3 (vendored, modified go-mp3 with float output, gapless trim and a fixed short-block M/S defect) for native and browser WASM import. Multichannel FLAC is rejected like WAV. Evidence tiers: `unit` (bit-exact FLAC, FFmpeg-oracle MP3 ≤1e-5, payload/corruption cases, fuzz) and `playwright-a11y-responsive` static browser suite 13/13 including real-WASM FLAC/MP3 import. Not done: QA/Devil's Advocate seat review, compressed legacy-library recovery.

## Protected merge and verified public domains — 2026-10-23

**Round E — bounded corrections verified and merged.** [PR #18](https://github.com/yegamble/aurialis-WASM/pull/18) merged normally at `043906fb712b3e26f324194c072e6a97da6fa2e5` from reviewed head `7de3bb1`, after all 14 jobs and app-bound GitGuardian passed in [run 40033188638](https://github.com/yegamble/aurialis-WASM/actions/runs/40033188638). Raw logs record 480 units/42 files, native shards 37/37/37 in 3.9/2.0/2.4 minutes, static 12/12 in 57.3 seconds, 13 oracles with maximum whitelisted error 7.105427357601002e-15, Newman 34/39 and raw security probes. Protection was rechecked; reviewed/merged trees matched and the branch was deleted. Post-merge [main run 40034009933](https://github.com/yegamble/aurialis-WASM/actions/runs/40034009933) also succeeded with all 14 jobs; raw main per-test counts were not separately inspected.

Root’s final local checkpoint passed 480 units/42 files (9.3 seconds), four native Reference cases (38.7 seconds), static 12/12 (39.8 seconds) and 13 oracles. Its 236-file proof received independent review. The same once-built browser artifact from `7de3bb1` then passed actual updated preview 12/12 (60.073 seconds), canonical 12/12 (61.028 seconds) and alias 12/12 (62.041 seconds), with zero skips, unexpected/flaky results or reported errors. The source tree equals merged main; the deployed artifact was not rebuilt or relabeled after merge.

Both `aurialis.yosefgamble.com` and `aurialis.yosef.app` now route to `aurialis-wasm`, version `c8c4df38-f672-4d81-aa6b-bb55e2c81c77`, with only its static `ASSETS` binding. Domain IDs and certificates were preserved. Both responses matched the exact 6,460-byte built HTML and `no-store, no-transform` header, with no observed external analytics request. Twenty-four inventories retain preview 365 HTTP + one Blob read and each custom domain 385 HTTP + one Blob read; all were same-origin GET/HEAD with no bodies, and recovery downloads were zero. Each custom-domain run added 20 same-origin GETs, including 18 to `/cdn-cgi/speculation`; initiators were not retained. CSP and privacy assertions remain unchanged.

**Ruling:** accept these finite hosted workflows and retain the failed first trial below. The new 281-file/26,596,385-byte edge index at `artifacts/reference-review-state/edge-proof-manifest.json` was independently rehashed and accepted for these bounded hosted workflows; all 14 raw PR logs and protection/merge receipts remain under `remote-7de3bb1/`. Evidence: `unit`, `wasm-bridge`, `api-curl`, `newman-e2e`, `playwright-a11y-responsive`. No old Worker, Container or R2 resource was deleted. Compressed clean PCM recovery remains required before permanent retirement. Album, studio DSP, trained stems and whole-product/Waves acceptance remain open.

## Historical Reference review state and domain rollback — 2026-10-23

**Round D — retain privacy assertions; correct lifecycle and edge responses.** Post-merge main `59d16f6` [run 40029786466](https://github.com/yegamble/aurialis-WASM/actions/runs/40029786466) failed one Reference unit, with 474/475 passing. Two controlled early-Apply cases failed against the old effect; `cb50bd8` acknowledges reducer acceptance before session invalidation and passed six focused cases. Root observed strict TS/lint/Knip and 478 units in 42 files, 8.92 seconds. This demonstrates a real race without proving it was the unique cause of the historical CI failure. Independent review reproduced a further rejected-Apply hang after a competing reference-only edit. The correction retains that exact reference snapshot and requires a new track record with the accepted settings before acknowledging success, preventing false acceptance of repeated idempotent Apply. All eight focused cases passed; competing settings, an earlier valid Revert and fresh analysis remain available after rejection. Final full gates subsequently passed as recorded above. Source identity and compare-and-swap authority are unchanged, without longer timeouts.

The fresh `59d16f6` browser artifact passed local static 12/oracle 13 checks and actual deployed preview 12/12 in 53.1 seconds. The canonical-domain trial then passed 4/12: eight unchanged same-origin request assertions failed after automatic external Cloudflare beacon injection. Canonical routing was restored to old `aurialis` at that checkpoint, with all old resources retained before the corrected trial above. No audio request bodies were observed in that trial. A hostname analytics exclusion failed HTTP 409 `maxRulesError`, changing no configuration.

**Ruling:** use the app response header `Cache-Control: no-store, no-transform` (`dc9fe16`), supported by [Cloudflare’s FAQ](https://developers.cloudflare.com/web-analytics/faq/), with exact HTML/RSC/WASM assertions. Keep CSP and same-origin/zero audio-body checks unchanged. Corrected custom-domain behavior was unverified at this checkpoint; the protected merge and subsequent hosted acceptance above supersede that pending state. Compressed recovery remains required before permanent retirement; whole-product and Waves acceptance remain open.

## Browser merge and legacy recovery — 2026-10-23

**Protected merge:** [PR #16](https://github.com/yegamble/aurialis-WASM/pull/16) merged at `85aa7cd7556a26e540e40212397624dcf30a16d6` from exact reviewed head `98397c6`. [Run 40021166540](https://github.com/yegamble/aurialis-WASM/actions/runs/40021166540) passed all 14 CI jobs and app-bound GitGuardian. Raw native shards passed 36/36/35 (107 total), and static browser passed eight. All seven app-bound protected checks, strict up-to-date PRs, conversation resolution and administrator enforcement were rechecked before normal expected-head merge. Reviewed and merged trees matched; local and remote feature branches were deleted. This closes the bounded browser-runtime integration, superseding historical awaiting-merge statements; it does not deploy a domain or certify studio/stem/Waves completeness.

**Round D — ACCEPT selected WAV recovery; BLOCK permanent retirement without compressed recovery.** The previous app retains original WAV/MP3/FLAC/OGG/AAC/M4A bytes in origin-specific browser files, independently of R2. Its existing UI performs orphan cleanup and restores/renders old settings, so treating it as a read-only original converter is rejected. Raw-original re-export is also rejected under CDR requirements. Add explicit key-only discovery, bounded paging, selected supported WAV reconstruction and fresh default projects while preserving every old record/original. Keep unsupported compressed originals and rollback resources until a separate clean PCM recovery path is qualified. No old metadata, scripts or preferences may deserialize/execute/map; no automatic bulk import or audio upload.

**Acceptance:** 32 eligible/64 scanned keys per page, explicit incomplete continuation handling, no database creation on absent storage, fixed encoded basenames with `create: false`, prompt caller cancellation/deadlines and no second unresolved browser-file read. Reserve original and canonical/storage-copy bytes through actual settlement. Check source changes around saving; rollback only a new staged asset. Keep canonical PCM hash/geometry authority distinct from old key/size/date checks. Replace discarded full import-validation PCM buffers with strict canonical 44-byte header geometry; preserve Go CDR and later sample validation. Reuse shared UI and native/static browser cases with no added production dependency.

**Round E — selected WAV recovery verified and merged in PR #17.** Independent security accepted the bounded storage/header seams, and independent QA/Devil's Advocate/writer/Product accepted the recovery source and wording. Full native `f77c71e` passed **111/111 in 6.3 minutes**, all Go quality/race/JS gates, 333 compiled fixtures plus nine history transitions and 45 schedules, 15 FFmpeg comparisons, Newman **34 requests/39 assertions** and raw probes. Fresh wording checkpoint `9f1c4ce` passed strict TS/lint/Knip, **475/475 units**, separate native/static builds and complete closed-artifact removal/restoration, embedded smoke, **4/4 native recovery in 12.1 seconds**, **12/12 static in 41.2 seconds** and 13 exact-audio native/WASM oracles. Eight static workflow inventories contain 365 same-origin HTTP asset requests plus one local Blob read, all GET/HEAD without request bodies; recovery downloads are zero. Canonical 12,044-byte WAV, source identity, all 33 old files and 66 old database records matched independent checks. Independent final evidence/doc review accepted the then-complete 123-file index and six-document sync. A later preview run overwrote 25 original raw observations by reusing the standard output directory. The original index remains at `artifacts/legacy-recovery/proof-manifest-9f1c4ce-original.json`; 98 byte-exact files are frozen under `artifacts/legacy-recovery/retained-9f1c4ce/`, with the loss recorded in `9f1c4ce-retention-audit.json`. All 14 remote PR #17 logs and the separate full-native 111/static 12-case results remain. Future runs require distinct output directories; replacement observations do not regain the earlier identity. Final spelling checked 265 files with zero issues; 114 local doc targets and all 11 generated agent definitions passed. [PR #17](https://github.com/yegamble/aurialis-WASM/pull/17) subsequently merged normally at `59d16f63fb9291bbb11107eaa88376b9d4275be5` from reviewed head `a9e2afa`, after all 14 jobs and GitGuardian passed in [run 40028570613](https://github.com/yegamble/aurialis-WASM/actions/runs/40028570613): 475 units, 111 native browser cases, 12 static cases, 13 parity oracles and Newman 34/39. Required app-bound protection was rechecked; reviewed/merged trees matched and feature branches were deleted. No deployment, compressed recovery or broader Waves/stem acceptance follows.

Retain setup REDs: the obsolete 200 MiB environment override prevented API startup; normal bounded harness setup passed. Canonical QA/loop instructions and generated mirrors now agree. Native test paths supplied to configured integration ESLint produced ignored-file warnings; the actual configured Worker/browser lint passed. Spelling scanned retained failure-report Markdown until generated `artifacts/` joined the generated-output exclusions; source checks and those setup failures remain, with the later raw-observation loss recorded above. The earlier implementation checkpoints below are historical, superseded by the observed gates above.

The complete frontend gate subsequently passed strict TS, configured lint, Knip and 475/475 units in 42 files (8.52 seconds), with Node 26.12.0 and Go 1.26.10 explicitly observed. Configured spelling passed 264 files with zero issues. Actual production builds and recovery browser execution remain pending; no deployment or broader completion follows.

Native `e86fc41` then built and passed smoke, closed five-member packing, actual complete removal/restoration and repeated smoke. The first actual recovery suite was **2/4**: exact selected CDR/defaults/preservation across six widths and real staged cancellation passed; unsupported/stale error assertions also selected Next's route announcer. Narrow all three error selectors to the named recovery dialog without changing messages, data assertions or timeouts. Retain the failed report/screenshots and rebuild the next clean source receipt before acceptance. Hostile and stale-publication checks remain open until that run.

## Release merge record

[PR #15](https://github.com/yegamble/aurialis-WASM/pull/15) merged at `01c2c158513de942e5c520dd6d383ca3feff0ccd` after exact head `002d1a5` passed all protected checks plus GitGuardian in [run 40013736325](https://github.com/yegamble/aurialis-WASM/actions/runs/40013736325). Its three browser shards passed 36/36/35 cases, totaling 107/107; the reviewed head and merge trees matched. This supersedes historical Release awaiting-merge statements without certifying the browser deployment or whole product. [Post-merge run 40014809849](https://github.com/yegamble/aurialis-WASM/actions/runs/40014809849) also completed successfully at `01c2c15`; its individual browser counts were not separately inspected.

## CI efficiency — 2026-10-23

**Protected merge record:** [PR #14](https://github.com/yegamble/aurialis-WASM/pull/14) merged at `d75f56a93691885e8459039f557c5709bb7cc75a` from exact reviewed head `f1c4e81`. [Final run 40003903109](https://github.com/yegamble/aurialis-WASM/actions/runs/40003903109) passed all 12 jobs, all six protected CI gates and 102/102 browser cases, split 34/34/34 in 2.4/2.4/4.1 minutes; GitGuardian also passed. All seven distinct Go role/source/image caches saved without collisions. Independent source, QA/Devil's Advocate and final Technical Writer/Product reviews accepted the bounded change. Reviewed and merged tracked trees were identical; local and remote feature branches were deleted. This closes CI reuse acceptance and supersedes the pending checkpoint below, without a controlled speedup or whole-product claim.

**Round D: ACCEPT.** Preserve the six protected statuses and every mandatory assertion. Build once per execution target, validate immutable same-run native/QA/WASM artifacts, and distribute browser tests over three one-worker VMs. Split measured Go static/security and race/meter work across separate VMs. Retain fresh test execution, zero browser retries and fail-closed aggregates; do not cache outcomes or reuse native UI assets as a browser target.

**Round E: open — awaiting final-head CI and merge.** Source `b563cbb` passed nine artifact units, four failure/signal/output-alias cleanup cases, actionlint/syntax, actual missing-file artifact restore, binary smoke, 333 static plus 45 automation compiled fixtures, nine history transitions, Newman 34/39 plus raw probes and two prebuilt-QA browser cases. Independent reviews corrected helper INT/TERM cleanup and the symbolic receipt guard. Preserve the earlier local `spawn go ENOENT` browser checkpoint; only its pinned-shell setup changed before the same assertions passed. Run [40001891791](https://github.com/yegamble/aurialis-WASM/actions/runs/40001891791) at `a23ce8d` passed every required check and all 102 actual browser cases, split 36/32/34 in 2.1/2.4/4.5 minutes. It exposed the shared Go cache save collision; `2d78c8d` isolates role/source keys and gives Chromium one cache writer. Test independence review permits `036076d` to shard individual tests with one worker per VM. Fresh collection covers all 102 exactly once as 34/34/34; revised actual runtime and successful role-cache saves remain required at the final head. [The task record](../../docs/tasks.md#ci-build-reuse-and-isolated-checks) retains baseline timings and evidence paths. No unmeasured speed or whole-product claim is accepted.

Deep PR #13 merged at `6154f87` after its required checks and both 102-case Linux runs passed. Older awaiting-merge statements below remain historical.

## Documentation review — 2026-10-23

**Scope:** README clarity, first-master guide, task-based documentation index and developer reference. **Merge and CI record:** [PR #10](https://github.com/yegamble/aurialis-WASM/pull/10), from `docs/readme-and-reader-guides`, records the live merge state and exact merge/check commits. Technical writer and independent claims-review agents checked workflows, formats, resource limits and feature boundaries against integrated main `f9ae077`, including measured diagnostics, Library recovery and measured Reference. QA checked the embedded build with the pinned tools. The [review record](../../docs/reviews/2026-10-23-readme-review.md) contains GitHub inspirations, claim sources and executed checks. This docs-only change does not close product backlog items or add browser/hardware certification evidence.

## Measured Reference merge record

[PR #9](https://github.com/yegamble/aurialis-WASM/pull/9) merged at `f9ae07753ccd76b3f45121f6782498d5854874e8`. This supersedes the awaiting-merge statements in the Reference checkpoint table and narrative below. Retained failures and scoped verification evidence remain historical; the merge alone adds no certification claim.

## Delegated continuation — 2026-10-23

### Encoded Release artifacts — local checkpoint

**Retained remote setup checkpoint:** run [40005567671](https://github.com/yegamble/aurialis-WASM/actions/runs/40005567671), head `e0a0765`, passed build/static/Go/API/WASM and two complete browser shards (36/36 and 35/35). The third runner spent more than eleven minutes installing Azure Ubuntu OS packages; after it eventually started, 30 passing browser cases were observed before the requested cancellation took effect. No complete 107-case remote pass or browser assertion failure is inferred. Logs remain in `artifacts/release-final/remote-e0a0765/`. Round D accepts bounded complete OS provisioning: a CI-only root-owned APT acquisition configuration, official HTTPS archive replacement for the known Azure endpoint, five-minute OS and separate four-minute browser-download limits. Playwright's required package set, all assertions and audio-test timeouts stay unchanged. Local syntax/actionlint and independent review precede a fresh protected run.

Retain the first failed endpoint-boundary probe: the substitution separator collided with regex alternation, and `58c0848` was prematurely pushed. The corrected separator passed all six layout/endpoint probes, keeping unrelated hosts and `/ubuntu-extra` unchanged; syntax/actionlint passed again. No application or assertion changed.

**Remote browser result and observer ruling:** run [40008371221](https://github.com/yegamble/aurialis-WASM/actions/runs/40008371221), head `07a18a9`, passed all corrected OS setup and non-browser gates but finished **106/107** browser cases. Shared-settings reported 0.402863 dB versus 0.12; its failing manual baseline was not retained, so the exact historical cause remains unconfirmed. Source/run/attempt ancestry was verified independently. Original-assertion diagnostics passed 10/10 in 59.0 seconds and a one-ms readiness-poll variant 10/10 in 54.9 seconds. Their real acknowledged transition windows establish an observer-readiness gap without proving that historical cause.

Round D accepts full one-second destination-energy comparison after two newly observed buffers, directly once at the unchanged 0.12 dB limit, plus a real 0.95-volume sensitivity/restoration control (known −0.4455279 dB, calibration allowance 0.05 dB). All exact settings/version/graph/freshness/playing/request assertions remain. Failed pairs and JSON-safe diagnostics are retained. The initial period checkpoint passed 3/3 in 1.6 minutes; final frame-drained checks passed 3/3 in 1.1 minutes. No application or tolerance changed. Fresh full protected CI and merge remain required; no old-root-cause, physical-output or whole-product certification is inferred.

**Encoded metadata ruling:** Album's strict receipt test exposed an input `pcmHash` leaking through an object spread. Copy only verified rate/frame layout fields; preserve the separate original source receipt and exact encoded-byte SHA-256. The eight-key regression and Release controller suite passed 10/10 in 657 ms locally, followed by all 406/406 units in 9.82 seconds, strict TypeScript, configured ESLint and spelling. No audio-processing or hash algorithm changed; full protected acceptance remains open.

**Locally verified — open, awaiting exact CI and merge.** The Release slice renders one 16/24/32-bit WAV from verified source/current settings or the acknowledged applied Deep script, inspects its encoded samples and bypass-measures that same file. SHA-256 identifies the output; repeated downloads retain its exact Blob. Six sourced profiles expose bounded delivery guidance rather than platform/hardware certification. Review applies no gain, trimming, resampling or repair.

The report binds source key/revision, encoding, processing and the full applied script. Cancel, source/settings/encoding changes and disposal reject late results. Explicit save uses full-record compare-and-swap; reload restores report JSON only and requires a new run for measured audio. Source replacement invalidates it. Exact output inspection and eleven finite diagnostic metrics are bounded, with source/counter/layout validation during hydration. All audio remains on the user's device; the separate browser-worker integration and CI-efficiency work do not close Release acceptance.

| Evidence tier | Observed checkpoint |
| --- | --- |
| `unit` | Fourteen core policy/inspection/binding cases and nine async controller cases cover final-file identity, malformed reports, cancel/retry, stale source/settings/encoding, missing-source recovery, retained same-Blob downloads, reload and complete-record save rejection. Fresh stable complete suite: **405/405 in 36 files, 9.54 seconds**, after a private-type export correction. Strict TypeScript, lint and Knip passed; the type-only correction changes no runtime behavior. |
| `playwright-a11y-responsive` | Focused production run **6/6 in 11.3 seconds**: exact 16/24/32-bit downloads and independent bypass metrics, six profiles/six widths with axe/44 px/keyboard, saved-report reload and source recovery, exact accepted-Deep native render, held real-response cancellation/encoding races and album regression. Both 320/1440 px screenshots were visually reviewed without an in-scope must-fix. Complete rebased production suite at `79299a0`: **107/107 in 9.7 minutes**, exit 0, with zero skipped/unexpected/flaky cases (581413.784 ms); stdout and JSON were checked independently. |
| `compiled-binary-smoke` | Focused runtime binary SHA-256 `1eeebd62620325dd5c296e45367d9df01d4c2f736c400e4cdd33013a20411c2b`; the rebase onto Deep main and private-type fix change no runtime behavior. The final rebased production build passed before the complete 107-case run; its binary SHA-256 remained identical. Fresh empty-directory smoke passed, including the production QA-path 404. |
| `newman-e2e` / `api-curl` | Fresh post-documentation run passed **34 requests / 39 assertions** and raw Host/oversize/security probes, exit 0 on unique loopback port 3931. Native embedded assets were rebuilt in a temporary binary without another Next build; no Go/DSP source changed. |

Stable ignored evidence is under `artifacts/release-final/` and `artifacts/release-controller/`; complete browser stdout/JSON and portable artifacts are `browser-full.log`, `browser-full.json` and `browser-full-results/` under the former. Retain the initial focused **3/5 failure**: a global alert observer matched Next's route announcer and an older response observer tried to parse the new first binary WAV as JSON. Scoped selectors and the response Content-Type corrected those observers without audio threshold changes; the corrected six-case run passed. Initial strict test-fixture typing/lint failures were corrected before the final controller commit. A full unit run overlapping the unfinished controller file was not used as final evidence; the stable 405-case run supersedes it. Knip's unused exported check type was made private before that fresh pass. Doc verification passed 81 local file/heading targets, the whitespace check and configured spelling with `--gitignore` (238 files, zero issues). The raw spelling glob first encountered an unknown word in a retained ignored Playwright error-context file; that evidence was preserved, not edited or deleted. The guide’s new acronym spelling annotation was corrected. Ordinary sandbox smoke/API attempts could not bind/connect loopback (permission denied); authorized reruns passed, and both setup-failure logs remain. Exact remote checks, independent final gate and merge remain required. Whole-product, studio DSP, trained stems, album consistency, AI repair and Waves acceptance remain open.

### Deep protected merge record

[PR #13](https://github.com/yegamble/aurialis-WASM/pull/13) merged at `6154f871e30b52fd9b6742ae2a87cf9d9cf2ef2b`, from exact reviewed head `c2250ac`. All six repository CI checks plus app-bound GitGuardian passed under the enforced strict PR protection. The PR browser run passed **102/102 in 7.4 minutes** ([39994806155](https://github.com/yegamble/aurialis-WASM/actions/runs/39994806155)); the push browser run passed **102/102 in 9.3 minutes** ([39994801796](https://github.com/yegamble/aurialis-WASM/actions/runs/39994801796)). Reviewed and merged tracked trees were identical. This supersedes earlier Deep awaiting-merge checkpoints without erasing their failures or extending acceptance to the whole product.

### Integrated Deep editor and live schedule checkpoint

| Item | Current status |
| --- | --- |
| MUB-3B browser editor/publication | verified and merged, PR #13 / `6154f87`; local corrected 102/102 and 382 units, both exact-head Linux 102-case runs and seven required app checks passed |
| Reference dependency PR #9 | verified and merged at `f9ae077`; all six jobs in CI 39939937259 passed, prior red checkpoints retained |
| ScriptV2 foundation PR #8 | verified and merged, `d999f4e` |
| Whole product, studio DSP, trained stems and Waves acceptance | open |

Runtime `f766dfb`, tests `341a426`/`dc3f7aa`, adds measured proposals, ten closed targets, exact source-frame editing, mute/explicit solo Apply, fixed-slot live publication and acknowledged native export/preview/release. Drafts stay inaudible. Pending baseline changes retain the accepted audio until complete acknowledgment and source/key/baseline/revision compare-and-swap. Postcommit uncertainty stops/rebuilds playback. Detach restores the accepted static baseline and Revert restores the complete first-Apply settings snapshot; both retain drafts. Full JSON persistence reports quota/corruption honestly; exact relink preserves source-bound state and replacement invalidates it. Static loudness/album normalization require Detach.

Chair-observed evidence: 360/360 units in 29 files, frontend static/build/binary smoke and focused 18/18 actual Chromium cases in 1.1 minutes on binary `7f7c160570af4a8c0eeb253f9969ed7842ff44b86a9e61c3b20513f556b706e5`. Four actual source/device-rate captured-input/native comparisons plus nonzero seeks passed, including all 128×256 compiled points at 192 kHz; maximum observed wet error ≈7.451e−9, zero observed missed quanta. Independent writer reran 61 focused units and inspected the four JSON/seek evidence pairs and 320/1440 px states. Captured-input `sourceVerified: false` remains distinct from separately verified actual canonical-Blob identity. These finite observations do not certify every browser deadline or acoustic equivalence.

Retain the server unsupported-flag, 41.25 px target, first-Apply clock, delayed arm/source-prefix, seek/pause, disabled-zero-module, Detach and uncertain-commit failures. Earlier 11/14 and 13/15 browser checkpoints and the loaded main-thread collector’s ten missed quanta remain evidence; bounded Worker capture and the corrected solo label passed unchanged audio thresholds before the final 18/18 focused integration. Product review required confirmation before reanalysis discards manually edited moves. Correction `5a76b79` now confirms every existing-draft replacement and rejects stale track/proposal/profile ownership; Keep/Escape performs no POST. Body portal `b18ad55` corrects the six sticky audio controls that had received pointer input behind the modal, with actual six-width focus/axe/touch/pointer checks. [Reference CI 39928617362](https://github.com/yegamble/aurialis-WASM/actions/runs/39928617362) is red after 70/72 browser cases (late Library callback and Reference RMS 0.2503 dB versus 0.05 dB); its prior local pass is not remote acceptance. Status: **open**, pending complete regression, exact green CI and delegated merge. No whole-product/Waves acceptance follows.

Finite-source correction `56853d9` binds native/Go loop policy per epoch and publishes a 24-byte integer start/end device-frame buffer guarded by an odd/even sequence. Finite conversion uses zero exterior and drains every valid aligned output sample before silence; finite→Repeat prepares a fresh epoch after the full pass, with a possible Preparing gap. Periodic→finite preserves that epoch’s conversion/history until the next input-cycle deadline; off→on removes the stop. This does not invent an IIR tail or seamless-loop guarantee.

The old 129-frame 8001→44100 finite source reproduced error 1.593142867. Actual corrected `9647a15` finite proof passed 6/6 in 22.0 seconds across four finite fixtures with zero/nonzero seeks plus two Repeat/latest-intent cases; observed dry/native-wet/speaker error was below about 2.974e−8, including delayed tail and post-end silence. A temporary isolated QA binary embeds a bounded static audio-thread speaker tap under normal handlers/CSP, while production binary/modules remain unchanged and the QA URL returns 404. Staged asset removal and trap cleanup, including build failure exit 23, were exercised. Retain rejected 404/Blob-CSP observers, polluted offline interception and 512 skipped ScriptProcessor frames after 13,184 matching samples; no raw wet substitute or threshold relaxation closes speaker acceptance.

Latest frontend static/build/smoke checkpoint passed all 372 units. The earlier loaded 371/372 timeout at 20.257 seconds remains; the quiet complete run passed 372/372 in 27.58 seconds (first case 6.845 seconds). The original combined run was interrupted after eight observed passes; no final result was claimed. A resumed attempt failed before testing because pnpm resolved to an incompatible runtime fallback. Explicit Node 26/pnpm 10.33.0 then passed **26/26 in 2.0 minutes**, exit 0 observed on clean `2c196ce`. Stable ignored stdout/artifacts are `test-results/deep-reference-finite-2c196ce-pinned.log` and `test-results/deep-reference-finite-2c196ce/`. Eight finite zero/sought captures reached worst dry 7.450580596923828e−9 and native-wet/speaker 2.9737091011838857e−8. Both 4001-frame/full-source and nonzero-seek cases delivered their final 3528 device samples, with 2139/237 silent samples afterward; stopped periodic dry/speaker error was zero.

Production binary `dc99844f2f487ccb0a74531cd3c24ef6add257a2c9342d297bccb8a9d27759b2` excluded the QA path (404 smoke). Separate test binary `47fd022322336f7841e353374f903c997b3fb18d861d68516d744f8fa05be8c0` served only the extra bounded observer; source/WASM/CSP remained unchanged and staging/temp binary cleanup was observed.

#### Full combined verification and main rebase

The combined Simple/Deep source at `1d21ccc` passed strict TypeScript, lint, Knip, configured spelling, strict browser-fixture typing and **382/382 units in 32 files (13.04 seconds)**. Go formatting/module/vet, lint 2.15, identifier/vulnerability checks and the full race suite passed; mastering race tests took 83.264 seconds. The fresh binary build, empty-directory smoke, independent meter checks, **333 exact static native/JS/direct/WASI fixtures plus 45 schedules**, Newman **34 requests/39 assertions** and raw cURL probes all exited 0.

The first complete combined browser run retained **101/102 in 7.0 minutes**, exit 1: an older control-isolation case still asserted that timeline automation was unavailable. Test-only correction `ecc9eff` checks the actual supported Analyze/automation disclosure while retaining musical-role/AI-repair unavailability and every profile-processing/separation rejection assertion. Its complete targeted case passed 1/1 in 3.0 seconds. The corrected full suite then passed **102/102 in 6.7 minutes**, exit 0, with zero skipped, unexpected or flaky cases (403140.75 ms). No audio threshold or production behavior changed for this correction.

All four delayed-epoch/static-prefix native PCM captures, six finite/tail/Repeat cases, source/storage/publication recovery, all nine Simple cases, both Reference device rates, shared controls, six-width accessibility and the complete export matrix passed. Finite dry maximum error was 7.450580596923828e−9; native wet and actual post-merger speaker maximum error were both 2.9737091011838857e−8. The 4001-frame fixture at zero/nonzero seek retained the final 3528 device samples (80 ms) and verified silence afterward. These remain finite software observations, not physical output, arbitrary-host timing, trained mastering or Waves certification.

Stable ignored evidence is under `artifacts/deep-simple-final/`: `frontend.log`, `go.log`, individual quality logs, `build-verify.log`, `browser.log`/`browser.json`/`browser-results/` for the failed original, `profile-corrected.*` for the targeted correction, and `browser-corrected.log`/`browser-corrected.json`/`browser-corrected-results/` for the complete pass. Production SHA-256: `9649c6f85605432b9485a9c70d0b73f5309bc08108db7bacd17c03c152ab1253`; separate QA SHA-256: `9197f52c5a1b0d6f00a5d78cff7e3321a563b6f5d1d8346a34a22e6164119046`. Production QA-path 404, unchanged production bytes and removed staged observer were observed. Temporary QA binaries are cleaned; no continued availability of their former paths is claimed.

The exact accepted local source is preserved as `codex/deep-proof-ecc9eff`. Deep was then rebased onto protected merged Simple main `4d0c745`; only the README conflicted, and the new reader-focused README and guides were retained. A mechanical comparison found **no differences in application source, browser tests, scripts, DSP, build configuration or dependencies** against the 102-case proof. The documentation sync adds the actual Deep workflow. This local pending checkpoint was superseded by the verified PR #13 merge record above; its full source, failures and finite evidence remain historical. Browser-worker integration/deployment, whole-product, studio DSP, trained stems, album consistency and Waves acceptance remain separate open work.



### Authorized repository protection and deployment work

| Item | Decision/current status |
| --- | --- |
| GitHub branch protection | applied; independent GET confirmed all six CI checks plus app-bound GitGuardian, strict up-to-date PRs/resolved conversations, administrator enforcement, no force push/deletion, zero human approvals |
| Cloudflare deployment | open; static app/WASM/model files only, all audio processing on the user’s device; prior container proposal superseded |
| Intended domains | verified `aurialis.yosefgamble.com` and `aurialis.yosef.app`; production switch and acceptance pending |

Browser workers/WASM must provide local import/CDR, analysis, mastering, separation and rendering. Native Go remains a device-local loopback fallback. No remote audio POST or hosted audio job is authorized. A static deployment alone cannot close those workflow gates. No resource deletion/replacement or completed production migration is claimed.

### Simple styles and measured Elevated checkpoint

**Verified and merged.** [PR #11](https://github.com/yegamble/aurialis-WASM/pull/11) merged at `4d0c745202c2192ebed918907a32704cb2d6c542`, from exact head `bf6b673`. All six checks in [CI run 39990817286](https://github.com/yegamble/aurialis-WASM/actions/runs/39990817286) and app-bound GitGuardian passed. The Chair observed 82 Linux browser cases in 7.7 minutes; an independent PR read confirmed the merge, exact head and successful checks. Earlier Simple failures and pending checkpoints below remain historical.

**Latest: locally verified — open, awaiting exact CI and delegated merge.** Clean `adf0032` passed the full 82/82 Chromium cases in 5.4 minutes, 342/342 units in 29 files (8.34 s), TypeScript/lint/Knip, production build/smoke and corrected 212-file spelling. Chair-observed full Go format/module/vet/lint 2.15/identifier/vulnerability/race gates passed; signal gates passed 333 exact static fixtures across native/JS/direct/WASI plus 45 schedules. Newman passed 34 requests/39 assertions and cURL probes. Independent writer checked `browser.log`/`browser.json`: 82 expected, no unexpected/flaky/skipped cases, exit-0 stdout. Binary SHA-256: `4eccb86c5928bfa782d69d78bd7dea8b2e78649fad60ebb48ca3301d7b2073f4`. Stable ignored evidence is under `artifacts/simple-final/`. Historical 79/81 and the inherited three-word spelling failure remain below; the new Deep union, device-local worker deployment and whole-product/Waves gates are separate and open.

| Item | Current status |
| --- | --- |
| Simple styles, Metal/Jazz, Depth/Presence | verified and merged, PR #11 / `4d0c745`; six CI checks plus GitGuardian passed |
| Elevated source-bound render review | implemented and locally exercised; upper-bound diagnostics, not normalization/certification |
| Reference dependency | verified and merged, PR #9 / `f9ae077`; all six exact CI jobs green, 73 Linux browser cases |
| Whole product, studio DSP, trained stems and Waves acceptance | open |

Runtime `79ddeb6`/`db74b8b`/`555a740` and tests `f1861b8` add original creative priors with explicit metadata version 2. Fresh recipe composition preserves current Input trim and LUFS/ceiling; zero intensity removes direction shaping while retaining explicit gain/limiter, and Depth/Presence combine once in either order. Manual controls clear active badges while remembering the last style/modifiers. Hydration does not remap saved processing; API mappings remain unchanged. Elevated requires known actual canonical-Blob identity, verifies receipts before/after native candidate measurement and checks returned layout, then rejects sample/reconstructed peak above ceiling +0.02/+0.05 dB or loudness above target +0.5 LU. Full-record ownership, cancellation and errors prevent stale publication; explicit Input correction survives retry. Attached Deep requires Detach.

Chair-observed static/build/binary smoke, 342/342 units in 29 files and configured 209-file spelling passed. Actual focused browser evidence is 9/9 in 1.7 minutes: seven independent live/native/export changes, hot-candidate rejection and explicit −18 dB retry/reload, plus six-width axe/44 px/keyboard. Independent writer reran 25 focused units and found no source must-fix. Retain the mistaken mock measurement-identity assumption and old test expectation of Input 6→0; final behavior preserves explicit gain. After rebase through Reference `e31114a`, the complete integrated run at `50fd265` failed 79/81 in 11.1 minutes: an actual 44.1 kHz Reference signal was compared with its 48 kHz export, and a Simple case expected explicit Input reset despite the approved preservation contract. Controlled two-rate captured-input/native Reference proof later matched both channels exactly and explains that integrated comparator error; the first Linux discrepancy remains unverified. The test’s obsolete Input 6→0 and later 4→0 assertions now preserve 6/4, but corrected execution is pending. The current 342-unit checkpoint remains historical; a fresh build, expanded 82-case integrated suite and exact remote CI are required. Status: **open — awaiting merge**. No Waves coefficients, learned song adaptation, target attainment, true-peak certification or whole-product completion is implied.

The fresh Simple preflight passed TypeScript/lint/Knip but stopped at configured spelling: three inherited wording errors in 212 files. Units/build/browser gates did not execute in that attempt. This five-document sync corrects the wording; a fresh spelling run, complete 82-case regression, exact CI and merge remain pending. Former temporary Simple/Reference output directories are unavailable; historical observed counts remain evidence of their recorded runs, without claiming retained raw artifacts. New output belongs in stable ignored `.verification/` paths.

### Measured Reference verified merge

PR #9 is verified and merged at `f9ae07753ccd76b3f45121f6782498d5854874e8`, from exact reviewed head `557442a`. All six jobs in [CI run 39939937259](https://github.com/yegamble/aurialis-WASM/actions/runs/39939937259) passed, including 73 Linux browser cases in 6.1 minutes (job `120370227089`, Chair-observed logs). Reviewed and merged tracked trees were identical; the primary checkout was fast-forwarded and both local/remote feature branches deleted. The earlier pending/failure checkpoints below remain history. Bounded implementation acceptance does not establish perceptual or Waves equivalence.

Simple rebased onto that merge with an identical tree (`e0488ef`→`be67c04`, exit 0). Its expanded 82-case regression, exact CI and merge remain open. Branch protection is verified applied; device-local deployment remains open; Deep/studio/stems and whole-product acceptance remain open.

### Measured Reference implementation and review history

| Item | Current status |
| --- | --- |
| MUB-3C measured Reference endpoint | verified and merged, PR #9 / `f9ae077` |
| Reference review, source binding, Apply/Revert | verified and merged within the bounded static-chain scope, PR #9 |
| ScriptV2 foundation PR #8 | verified and merged at `d999f4e`; exact source `f29bc8c`, all six CI jobs green |
| Whole product, studio DSP, trained stems and Waves acceptance | open |

Reference runtime `47b856e` and UI assertions `2f97b27` compare complete baseline-rendered source against raw reference audio, using normalized common-band spectra. The bounded EQ/opt-in-width proposal preserves unrelated chain fields and disabled stages, verifies actual output residual/protected bass, and falls back to the exact baseline. Full-output and contour-fit diagnostics remain separately labeled. Client canonical-Blob receipts, exact baseline/options/delta validation, complete-record Apply and one session baseline/Revert close the former saved-settings blend workflow. Attached Deep automation requires Detach.

Independent review retained and corrected the raw-source/zero-residual defect for a non-neutral chain: reported output mismatch now improves approximately 7.110→4.540 dB, corroborated by independent tones at 7.120→4.542 dB. A no-audible-energy candidate is rejected internally, not retained as an infinite or falsely successful JSON result. Width and bass constraints are jointly verified on complete rendered output. These are source-specific broad-band checks, not perceptual or hardware equivalence.

Final local evidence at source `2f97b27`: full frontend static/unit and configured 203-file spelling, rebuilt binary/smoke, all 333 frozen PCM and 45 automation fixtures, independent meters, Newman 34 requests/39 assertions plus raw probes, and the complete browser suite **72/72 in 3.8 minutes** passed. The earlier full Go quality/security/race checkpoint precedes the final erased-energy follow-up; changed mastering/jobs/server packages separately passed final race/lint. Three actual browser workflows passed in 13.2 seconds, including native/export equality, live RMS agreement and six-width accessibility. Independent writer review passed 11 client/receipt/panel units and hostile API/non-neutral/erased-energy tests; DSP passed six final high-Q/dense-frequency/settled-tone/energy/width/mono/correlation regressions with no remaining in-scope must-fix.

Retain the initial isolated-worktree Newman missing-asset failure and symlinked-dependency Turbopack failure; rebuilt assets/local frozen installation corrected those setup conditions. Independent QA/Devil's Advocate/Technical Writer/Product review accepts the measured static-chain Reference implementation and synchronized documentation, conditional on its own exact green CI and delegated merge. The PR #8 foundation is verified and merged as recorded below. Status: **locally verified; open — awaiting merge**. Whole-product and Waves acceptance remain open.

A later integrated Simple checkpoint at `50fd265` failed 79/81 browser cases in 11.1 minutes. Reference render-thread RMS was −26.46243 dBFS versus −26.215245 dBFS for the source-rate 48 kHz export, a 0.247185 dB difference; its separate three-window speaker readings were about −26.4639197545 dBFS, and the actual AudioContext rate was 44.1 kHz. The later controlled proof below explains this integrated discrepancy as an invalid source/device-rate comparison. It does not establish the cause of the earlier Linux discrepancy, whose actual device rate was not recorded. The other failure retained obsolete Simple expectations that a direction resets explicit Input 6→0 and later 4→0, contrary to the approved gain-preservation contract. The two stale Simple assertions have now been changed to retain Input 6 and 4; their corrected complete integrated outcome remains pending.

[CI run 39937462719](https://github.com/yegamble/aurialis-WASM/actions/runs/39937462719) separately failed the Reference panel unit checkpoint, 331/332. Its test fired a click during a protected intermediate render before Apply/Revert became enabled, so no user action occurred. The test now waits for enabled Apply before repeated application and enabled Revert before clicking, then verifies both exact starting settings and the restoration message. Correction `3d57b47` retains production ownership guards. The three focused panel units passed in 259 ms; this checkpoint does not establish a production Revert failure.

Test-only correction `de6269f` forces both 44.1 and 48 kHz devices, captures 262,144 actual device-input/wet frames, and submits that exact Float32 input at its actual rate plus unchanged proposal parameters to native rendering. The controlled proof exited 0: **2/2 in 1.1 minutes**, with both-channel wet errors exactly zero and no missing capture quanta at either rate. At 44.1 kHz, worklet/speaker-median/native RMS was −26.462430836/−26.463919754/−26.463919755 dBFS; at 48 kHz it was −26.214787729/−26.215243981/−26.215243981 dBFS. Source-rate 48 kHz export remained −26.215245432 dBFS. This reproduces the later integrated comparison error while retaining per-channel PCM <1e−6 and both original 0.05 dB limits against rate-correct native output. Exact source-rate downloaded/native PCM equality remains separate. The values above were observed in stdout; the former temporary values file is no longer available and is not retained raw-output evidence.

The controlled proof used existing embedded binary SHA-256 `3219133870f4de54be357133d49bf2010f0519d8996592578598cc1cd92f0aa7`: DSP was unchanged, but the newest Tools copy was not embedded yet. Strict E2E typing also passed. A fresh full binary build, complete **73-case Reference** regression, complete **82-case Simple** integration and exact green remote CI remain required; focused proof does not replace them.

A subsequent entry-point audit corrected the Tools card, which still described Reference analysis as unavailable. It now describes the implemented measured review workflow; no processing or API contract changes.

The next [CI run 39935896825](https://github.com/yegamble/aurialis-WASM/actions/runs/39935896825) stopped at the dead-code gate: `renderOutputLevel` was exported although only used inside its test helper. Making that function private changes no observer behavior, production processing or tolerance. This omitted local dead-code check is retained as a failed checkpoint. Independent review reran the full configured local Knip check after the correction: exit 0. Corrected exact-head CI remains required.

The first Linux [PR #9 CI run 39928617362](https://github.com/yegamble/aurialis-WASM/actions/runs/39928617362) failed **70/72** browser cases; its other verification jobs passed. Library observed one queued 1024-frame callback after the test had counted a request to close as completed closure. Reference observed a 0.250319292 dB difference in its one-second speaker-feed aggregate. The cause of that Reference discrepancy remains unproven. Native/export equality and numerical proposal guards passed; no production processing change follows from this checkpoint.

Test-only corrections `d9b80f7` and `cf5793b` await fulfilled native AudioContext closure and require its clock to remain stopped. Reference now additionally checks continuous, timestamped, equal-duration actual worklet energy over at least two settled seconds. A separate speaker-feed probe uses a fixed three-window median. Both retain the original **0.05 dB** tolerance, independent native rendering and exact both-channel downloaded PCM equality. A deterministic 1500 ms delay of the actual ready-message delivery also exercises readiness; the old observer passed that local delay probe, so this does not prove the Linux cause. A custom test-worklet interception attempt returned 404 and a Blob attempt hit CSP; neither workaround nor a CSP change was retained. The corrected targeted two cases passed in 25.9 seconds; the fresh complete suite at `cf5793b` exited 0: **72/72 in 4.3 minutes**, using production code identical to published `6b61331`. These are local results; corrected exact-head Linux CI and delegated merge remain required.

The owner authorized merging PR #6 and continuing the whole-product loop with `merge=delegated` until all planned features and remaining Waves acceptance work are tested. This explicit continuation supersedes the default four-iteration stop. Verified branches may now merge after the existing QA, Devil’s Advocate, Technical Writer, Product Engineer and green-CI gates without another owner merge question.

PR #6 was already merged when this continuation began: merge `388653635a4911b66786c672b2551cde235f7b4a`, verified source `8fd8877`. Corrected [CI run 39838476152](https://github.com/yegamble/aurialis-WASM/actions/runs/39838476152) succeeded, including 61 Linux browser cases in 5.0 minutes and 22 Newman requests/27 assertions plus raw probes. MUB-2A, MUB-3A and MUB-4A are verified and merged within their bounded scopes. The clean primary checkout was fast-forwarded; the merged branch was deleted locally and remotely. The older pending statuses below are historical checkpoints.

Continuation baseline: clean `main` at `3886536`; isolated integration branch `codex/waves-completion`. Three independent Round A councils are reviewing DSP/version/latency, ScriptV2/security/model feasibility, and Library/import/recovery. Whole-product completion and Waves equivalence remain open. No sonic algorithm 2, trained separation or automation is implied by the foundation merge.

### Round D continuation ruling

| Item | Decision and reason | Acceptance and ownership |
| --- | --- | --- |
| MUB-2B private preparation | ACCEPT private Optical, Variable-Mu, VCA and FET primitives; do not publish an incomplete algorithm 2 whose later sound/latency would change saved projects | Independent transfer/ballistics/rate/silence/DC tests and compiled execution; legacy compressor path untouched. DSP council owns new studio compressor files. Public activation remains gated on the coherent studio bundle and recoverable migration. |
| MUB-3B typed automation | ACCEPT ScriptV2 with source identity, closed typed targets, bounded common Go evaluator, native rendering and separate schedule ABI | Exact source binding, bounded fields/IDs/coverage/overlap, atomic revision publication, rational source/device clock and partition invariance. Input gain and width remain per sample at their correct stages. Expensive fields use an absolute device lattice no longer than 1 ms; curves exceeding declared cell tolerances are rejected explicitly. Backend owns automation/mastering/jobs/server/schedule bridge, excluding private studio files. |
| LIB-1 upload and Library lifecycle | ACCEPT sequential multi-import, sort, real quick preview, duplicate settings, album assignment, identity-based relink, awaited deletion and storage guidance | Reuse CDR import and live engine; one active import/preview; bounded aggregate session fallback; independent duplicate source; staged replacement preserves old source until metadata durability; meaningful denied/quota/cancel/reload probes and six populated responsive widths. Frontend owns library/import/storage components and adapters. |

Round B changed the plan: dense one-frame points must not cause per-sample coefficient preparation or silently lose authored curves; neutral fast bypass must not swallow scheduled input/width. Initial maximum cell variation is 0.1 dB for EQ/threshold, 0.01 absolute ratio and 0.1 percentage point saturation, including fades. These bound parameter sampling error, not universal audible error. A compiler error directs users to extend fades or reduce changes. Unsupported repair targets remain rejected and automation never implicitly enables modules.

The Library review found an unbounded memory fallback after failed IndexedDB writes. New imports need a typed durable/session/unavailable outcome and a finite aggregate session cap. Canonical identity will travel in the existing source-metrics import header; filename or byte size is not identity. Replacement stages a fresh source key, preserves the old source on persistence failure, invalidates source-dependent artifacts only on explicit replacement, and retains project/settings/album identity. Rejected bloat: a second DSP preview engine, arbitrary automation object paths and a broad shared-source reference-count migration.

No code in these continuation items is accepted as complete yet. Each implementation must sync the five documentation surfaces and survive independent QA/Devil’s Advocate, native/WASM/static/API/browser/build gates and green CI before delegated merge. Training/runtime/quality evidence for real 2–6 instrument stems remains an independent open requirement; the original Python Demucs service is not a drop-in single-Go-binary implementation.

### LIB-1 peer findings and navigation ruling

Peer review found that merging a replacement patch retained deleted derived fields, a duplicate IndexedDB key could mask a request `ConstraintError` and fall through to session storage, and Library held-scrub did not share Master lifecycle behavior. Dedicated full-record source revision commits, factory-issued immutable assets with request-error preservation, optional-field hydration checks and a shared scrub hook correct those findings. The integrated intermediate frontend checkpoint passed TypeScript, lint and knip plus 317 cases in 22 unit/component files.

The denied-storage browser test then proved a full-document Home-to-Master navigation, discarding the module's session audio. Round D accepts the documented native History API with known workstation routes selected from the live pathname. Back/Forward, direct deep-link reload, modifier/target/download semantics, focus/scroll and old graph disposal require execution proof. Do not rewrite private Next RSC payloads or move raw audio into alternate persistent browser storage. The original failed test remains evidence; LIB-1 is open pending the correction and full integrated gates.

### LIB-1 Round E local acceptance — source 3c88027, tests 7e8811b

**Locally verified; open — awaiting merge. Whole product incomplete.** Corrected full Chromium suite passed 70/70 in 7.7 minutes, with no retries/skips. All nine new Library cases passed, including denied-IDB in-app navigation/Back/Forward/live/export until reload, staged-write cancellation, exact relink, explicit replacement with failed metadata persistence, independent copy/delete, queue cancellation and six populated widths/18 dialog axe states. The earlier 22/23 targeted checkpoint included one pre/post-hydration fixture equality failure; its corrected baseline and complete rerun passed. No product assertion was waived.

Integrated TypeScript/lint/knip/spelling passed; 321 unit/component cases in 23 files passed. The full Go quality/security/race gate passed this session on identical runtime Go `b701f4d`; later changes are frontend/tests/docs. Fresh compiled native/JS/direct/restricted-WASI paths matched all 333 frozen fixtures exactly, plus nine model-history transitions. Independent FFmpeg meter verification passed 15 comparisons (maximum 0.0542 LU / 0.0312 dB). Fresh single-binary rebuild and empty-directory embedded smoke passed. Newman passed 22 requests/27 assertions plus raw security/size probes; all 11 agents synchronize.

Independent QA/Devil's Advocate/Product/Writer review found no surviving in-scope source must-fix; 58 targeted units and native identity/import tests passed, all 65 local documentation links resolve, and a real 320 px footer scroll/focus/click probe passed. Library 3 dB fixture measured +2.9999999208 dB live / +3.0000000435 dB exported, held-scrub resumption and two closed contexts. These are bounded application observations, not acoustic equivalence or hard deadlines. Final exact documentation review and green remote CI are still required before delegated merge. Partial deletion and unswept orphan limitations remain explicit in tasks/architecture.

### LIB-1 and MUB-3B foundation merged

LIB-1 is verified and merged in PR #7 at `25d5653280585198df510215a58c3c07b92193ea`. All six jobs in [CI run 39906520601](https://github.com/yegamble/aurialis-WASM/actions/runs/39906520601) passed, including 70 Linux browser cases in 4.9 minutes. The primary checkout was fast-forwarded and the merged branch deleted. Earlier local/pending statuses above are historical.

MUB-3B's bounded API/native/numeric-WASI foundation is verified and merged in PR #8 at `d999f4e7b430ed33cf315c388ac8b3531d434642`, from exact reviewed source `f29bc8cfbcf18d73b3785720ae4d88e798961cae`. All six jobs in [CI run 39926912858](https://github.com/yegamble/aurialis-WASM/actions/runs/39926912858) passed, including 70 Linux browser cases in 5.3 minutes. The primary checkout was fast-forwarded and the local feature branch deleted; remote branch deletion was underway at this checkpoint. Subsequent local/pending statements retain their earlier checkpoints.

| Item | Current status |
| --- | --- |
| LIB-1 Library/source lifecycle | verified and merged, PR #7 / `25d5653` |
| MUB-3B ScriptV2/common schedule foundation | verified and merged, PR #8 / `d999f4e` |
| Deep editor and actual browser schedule transport | open; not delivered by the kernel/API foundation |
| Whole product and Waves acoustic acceptance | open |

The MUB-3B foundation includes source-bound strict JSON, measured neutral proposals, native actual-PCM verification, off-thread compilation and staged numeric WASI revisions. Schema 2.0 retains sonic algorithm 1, sample-peak limiting and disabled repair; proposals use the existing generic Optical path. The compile endpoint truthfully returns `sourceVerified: false`. Static setters and different-source binding reject while attached; same-source binding is idempotent and detach restores baseline. Source/device phase, half-open/faded envelopes, bounded heavy-control cells and baseline/module semantics require their declared tests rather than a label-based completion claim.

The Chair observed full Go quality/security/race gates passing after first-Apply clock correction `b3237e3`; captured static-prefix oracle `8de5063` separately passed vet/lint/race. Post-correction build/empty-directory smoke, 333 frozen PCM fixtures, nine history transitions, 45 compiled automation fixtures and Newman 29 requests/34 assertions plus raw probes passed. The earlier unchanged-frontend checkpoint passed static gates, 321 units and configured 177-file spelling; 15 FFmpeg comparisons passed at their recorded checkpoint. Independent schedule/slot/seek/loop/bridge/strict-JSON/native-source/API tests and the complete automator package passed. Preserve the strict-lint, endpoint-rounding and unsupported-baseline findings, the old-reactor clock-fixture failure corrected by rebuilding, the failed tool-URL lookup and loaded Node timing outliers up to 347 ms. Those probes are not browser or universal deadline evidence.

Round E reopened first Apply because static playback did not advance a schedule-independent clock. The correction binds an independent rational source epoch before playback; static/bypassed blocks advance it, same-identity binding preserves it, and first Apply/detach/reapply retains fractional phase. Seek/reset explicitly reconstructs the epoch; hold/pause submits no processing frames. Native and actual compiled-WASI fixtures now include 16 independent static-prefix epochs in addition to the prior 29 fixtures. No ABI signature changed.

The prior pre-correction existing-UI suite passed 70/70 in 5.9 minutes. The post-correction run was 69/70 in 4.3 minutes, failing keyboard focus after transport Space-hold/Escape/resume. Ten unchanged traced repetitions passed but do not replace a complete corrected acceptance run. A deterministic intermediate-render regression reproduced a matching transport focus-ownership race against old source, failing one of 11 unit cases; ownership cleared before asynchronous resume disabled and blurred the origin. Correction `ba4406d` passed all 11 transport units, strict frontend gates, the complete 321-unit suite and fresh build/smoke. It preserves keyboard ownership through the paused render and releases it on a new hold or intentional enabled blur. Fresh complete browser verification remains pending; identical cause for every prior failure is not established. The current UI does not bind the new schedule clock; no clock-causation claim follows. Final browser regression, documentation sign-off and green remote CI remain required before delegated merge. The foundation is not merge-ready and no whole-product acceptance follows.

**Final Round E local acceptance:** the fresh corrected complete browser suite exited 0, 70/70 in 3.5 minutes, without relaxing the original assertions. Independent QA/Devil's Advocate/Technical Writer/Product accepted the bounded foundation contracts, evidence and atomic commits with no remaining in-scope must-fix. Status: **locally verified; open — awaiting merge**, conditional on exact green remote CI before delegated merge. Earlier pending and failed checkpoints above remain historical. This is existing-UI regression evidence, not an enabled Deep editor or actual browser automation continuity claim.

After rebasing onto merged PR #7 `25d5653`, the Chair and independent writer compared the full tracked trees and found no differences. Current rebased commits are `e2e7432` (first-Apply clock), `e581a86` (captured static-prefix oracle) and `de852d3` (transport focus); earlier hashes identify executed pre-rebase checkpoints. Whole-product, Reference, studio DSP, trained stems and Waves acceptance remain open.

## Whole-product loop — 2026-10-22, current session

**Status: bounded wave locally verified; open — awaiting merge. Product incomplete.** Baseline `f5ec9ad` is clean main, including merged PRs #3/#4/#5. MUB-0 is resolved; its earlier blocking ruling below is historical. The [whole-product review](../../docs/reviews/2026-10-22-war-room-completion.md) records surviving requirements and the supplied Gemini conversation’s stale claims.

Round A councils: DSP/audio/target audience; frontend/design/Devil’s Advocate; backend/security/QA. Round B challenges narrowed the compatibility claim to implemented algorithm 1 and required high-pass-specific control semantics and refined change-point localization. Round C accepted those revisions. Round D accepts isolated MUB-2A compatibility/capability foundation, MUB-3A measured features/neutral sections and MUB-4A supported EQ/limiter controls. Sonic v2, automation, trained stems, measured reference/album consistency and platform acceptance remain open. Existing passing gates cannot close them.

| Item | Decision | Current status |
| --- | --- | --- |
| MUB-0 | Prerequisite resolved by merged PR #3 | verified merge ancestor `97964fc` |
| MUB-2A | Implement version/capability foundation; advertise algorithm 1 only, latency 0/drain 0 | locally verified; open — awaiting merge (`codex/product-completion`) |
| MUB-3A | Implement bounded measured source features and neutral sections; no invented moves | locally verified; open — awaiting merge (`codex/product-completion`) |
| MUB-4A | Expose supported band enable/type and limiter release; prove live/export effects | locally verified; open — awaiting merge (`codex/product-completion`) |
| Whole product | Original full planned scope retained | open — acoustic and product requirements remain |

Final local acceptance: TypeScript/configured lint/knip, 302 units across 20 files, full Go format/module/vet/exact lint 2.15/identifier/vulnerability/race, both WASM target lints, 333 exact compiled fixtures (legacy and negotiated ABI 2), 15 FFmpeg meter comparisons, production build/empty-directory smoke, Newman 22 requests/27 assertions and raw probes passed. Final full Chromium suite exited 0: **61/61 in 3.1 minutes** on binary `8552941fc6e8b3d9b95fe2ecd378c539f3fe24b7fecf2521741fc1582b410171`, runtime source `fd782c9`; subsequent changes are tests/comments/docs. Final spelling checked 146 files, zero issues.

Retained failed checkpoints: noise bandwidth bias, 192 kHz low-band resolution, Hann impulse loss from windows without overlap, initial measured UI status mismatch (0/2), delayed held-admission cancellation, overlapping mobile targets, stale-copy full suite (60/61), and phase-sensitive Tape snapshot full suite (60/61). The coverage fix passed independent impulse/edge/extreme/DC probes; full-period live observations retained the >0.08 dB activation threshold and passed two predetermined shortcut sets (8/8), followed by the final 61/61 suite. Independent Cancel/retry/late-response cleanup completed with controls restored in 60 ms and the new result preserved. The review records exact scope and failures.

QA/Devil’s Advocate accepted the bounded corrections with no remaining in-scope must-fix; Technical Writer/Product Engineer accepted synchronized contracts and atomic commits, subject to recording final evidence. Four loop iterations are recorded; the default owner merge gate remains. Remote checks are tracked in the PR and must pass before owner merge. The whole product, sonic v2 and Waves equivalence remain open; no merge or all-product completion is claimed.

Remote checkpoint: [Remote PR run 39836685651](https://github.com/yegamble/aurialis-WASM/actions/runs/39836685651) passed every verification job except the browser job, which finished 60/61. Its measured-analysis case passed all diagnostics and six-width accessibility assertions, then failed writing a screenshot to macOS-only `/private/tmp` on Linux. The test now uses Playwright’s per-test output directory; no application code, assertion or threshold changed. Strict typing/spelling and the corrected two-case browser run passed (2/2 in 6.1 seconds). Corrected remote acceptance remains pending in PR checks; the earlier local 61/61 checkpoint is retained separately.

## Current ruling — 2026-10-21 product recovery

The latest whole-product review audited local and remote `main` at `ade7736` (the only live branch). The blanket verification claims in the historical activation record are withdrawn. The corrected design archive matches the canonical checked-in Figma source exactly.

[The baseline audit](../../docs/reviews/2026-10-21-war-room-audit.md) records 17 recovery findings. The earlier corrective subset on `codex/war-room-product-audit` was locally verified; **open — awaiting merge**: direct Go WASI playback, canonical settings, import/recovery, transport and responsive repairs passed the recorded gates, all 39 local browser cases, bounded five-minute actual-song output and six-job source CI at `e91d2f0`. The owner merged [PR #2](https://github.com/yegamble/aurialis-WASM/pull/2) on 2026-10-22 at 00:31:56 UTC, merge commit `30f576f9d2b7008240f57d62f691e2536c172be5`.

Broader trained separation, source-derived AI analysis, musical automation, spectral matching, hardware/true-peak/platform certification and arbitrary-workload capacity remain open. The chronological entries below retain failures and pending statuses as they stood at each checkpoint; the final acceptance entry supersedes their current-status implications without erasing them. Original “Failed to fetch” causation remains unverified.

## Current expansion — Advanced mastering controls and preset calibration

**Status: locally verified — open, awaiting merge (`codex/advanced-mastering-controls`).** The owner requested audio-engineer and DSP-plugin-engineer implementation informed by public Waves documentation. Prior corrective PR #2 was independently owner-merged; this new scope requires a new PR, remote CI and merge. Earlier accepted runtime evidence remains historical.

DECISION: ACCEPT the bounded local implementation of original processing controls and conservative Simple recipes; remote CI and merge remain pending.

WHY: Makeup/knee/detector and stereo crossover were hidden or fixed; mid/side gain, adaptive release, dynamic de-harsh, three-band dynamics and named coloration now have shared DSP and UI wiring. Simple genres remain starting points, not proprietary Waves recipes or source-adaptive mastering.

AFFECTED LAYER: wasm-dsp, go-backend, nextjs-ui, qa, docs.

USER / AUDIO IMPACT: Canonical state and idempotent shortcuts retain explicit control. Legacy sessions preserve old character choices and new stages default off. Clean is identity; manual Release is inactive during automatic recovery, and retained values return when their modes change.

DISSENT / LIMITS: De-Harsh overshoot and large saturation drive-change transients were reproduced and corrected through Q normalization and antiderivative-history rebasing, with tests of those cases. First-order complementary multiband is not linear-phase or steep band isolation. Named coloration is not a hardware clone or alias-free guarantee. Zero runtime counters and fixture parity do not certify all host scheduling, signals or transitions.

CURRENT EVIDENCE: Stable binary `dce7b7f8513a2fe0d272059727b4a97fb43346e7745021e31efc40b84b6abb69`; 183 units, final TypeScript/lint/knip, 121-file zero-issue spelling, Go vet/race and full native/JS/WASI quality/security gates passed. All 333 native/offline/direct/live fixtures matched exactly. Stable build, empty-directory binary smoke, Newman 17 requests/22 assertions and raw curl probes passed. Final Chromium **42/42 in 2.2 minutes**, including the **62-control export matrix in 31.7 seconds**, passed. Isolated Brave **3/3 actual-output checks in 17.9 seconds** passed. These are unit, wasm-bridge, api-curl, newman-e2e, playwright-a11y-responsive and compiled-binary-smoke evidence at the documented scope.

RETAINED FAILURES: First parity attempt raced a mid/side source change and passed after a stable rebuild. Threshold and Tape/Tape Warmth strict-selector ambiguities were corrected; the preceding full suite was 41/42 (62 exports passed in 43.2 seconds), then exact-selector targeted checks and final 42/42 passed. Earlier simultaneous Brave imports failed 2/3 with server busy/admission responses; isolated rerun passed. None of these observations erases the actual DSP defects corrected above or certifies arbitrary workloads.

The [research contract](../../docs/mastering-controls-research.md) and [task evidence](../../docs/tasks.md) record sources, values and limitations. Documentation sync is complete for this local checkpoint; remote CI and owner-authorized merge remain required.

## War-room ruling — 2026-10-22 Mastering Upgrade Blueprint (`/war-room`, review only)

**Seats:** `aurialis-dsp-plugin-engineer`, `aurialis-backend`, `aurialis-frontend`, `aurialis-devils-advocate`, `aurialis-grammy-veteran` (read-only, lighter models per owner budget request). Rounds B/C were skipped under usage-budget rule 5 because no seat disputed another seat's BLOCKER or REQUIRED item. No application code was modified.

The Chair confirmed these blueprint claims are stale: the live ABI has 81 values (not 56), `compSlowDB` and `ironHP` are in use, and `AdvancedDynamics.tsx` already exposes knee, makeup, sidechain HPF, auto release, M/S, mono-bass frequency, De-Harsh and multiband. Prompt 1 is already fulfilled by [the upgrade spec](../../docs/design/waves-parity-and-hardware-emulation-spec.md) (`1539b6a`). That spec stays canonical, and the blueprint's equations and genre numbers are inputs to calibrate, not acceptance evidence.

```text
DECISION:            BLOCK (sequencing) — no new implementation branch until codex/advanced-mastering-controls is merged to main.
WHY:                 Finished-means-merged; new DSP/UI slices touch the same engine.go / AurialisWorkstation.tsx files (devils-advocate-1).
DISSENTING VIEW:     None.
```

| ID | Pri | Blueprint item | Decision | Acceptance / gate |
|---|---|---|---|---|
| `MUB-0` | P0 | Merge `codex/advanced-mastering-controls` | BLOCK prerequisite | Owner PR merge plus green remote CI; then branch per slice off `main`. |
| `MUB-1` | P1 | Prompt 1: spec | REJECT (duplicate) | Already committed. Tau unit clarified in §4 (seconds = ms × 1e-3). |
| `MUB-2A` | P1 | DSP foundation | ACCEPT (spec §7 step 1) | `AlgorithmVersion` (v1 default, v2 opt-in), versioned 82-value ABI handshake, `LatencyFrames()` plus drain, fixed delay buffers. v1 PCM bit-exact (max abs err 0) on all 333 fixtures; 0 allocs/op at block sizes 1/127/128/129/4096 and 8–192 kHz. |
| `MUB-2B` | P1 | Compressor topologies | MODIFY | v2 only; one topology per commit, Optical first (separate fast/slow states; long-burst recovery ≥2× slower than a 50 ms burst; steady-state error ≤0.1 dB). Generic labels only (Optical/Vari-Mu/VCA/FET), no hardware product names. |
| `MUB-2C` | P2 | Saturation oversampling and LR4 | MODIFY | Polyphase FIR with measured stop-band rejection ≥60 dB; separate tape/transformer state; LR4 all-pass applied to Mid *and* Side; branches −6.02 dB ±0.1 at crossover; phase ≤1°; width=0 null ≤1e-6. |
| `MUB-2D` | P1 | Lookahead limiter | MODIFY | 2 ms time-based lookahead (`ceil(fs*0.002)`, ≤384 frames), not 64 fixed samples. ≤ ceiling+0.05 dBTP verified against an independent oversampled oracle on final output. |
| `MUB-3A` | P1 | Analysis and segmentation | MODIFY (spec §7 step 5) | Standalone `AnalyzeFeatures`/neutral `Section 1..N` with confidence; aggregated Hann FFT frames (a 4096-point FFT ≠ a 1 s window); silence gives 1 section; step change localized ≤250 ms; band power ±0.5 dB on tones/noise. |
| `MUB-3B` | P1 | ScriptV2 render route and data-driven moves | ACCEPT (step 6) | Closed target allowlist; `script` mutually exclusive with `params`/`profile` (400); EQ proposals ±3 dB regularized fit; Newman cases added. |
| `MUB-3C` | P2 | Reference endpoint | DEFER (step 7) | Both WAV parts through CDR; joint memory reservation `(src+ref) frames` in `admitLocked`; amount=0 identity; protect-low within 0.25 dB. |
| `MUB-4A` | P1 | EQ band type, band enable, limiter release UI | ACCEPT (first UI slice after MUB-0) | DSP and live-control indices already carry them (`live-controls.ts:30,37`). Shared primitives, ≥44 px, six widths plus axe; each control must change exported *and* live PCM. |
| `MUB-4B` | P2 | Topology / true-peak / repair UI | DEFER | Exposed only after MUB-2B/2D and repair DSP pass, and after `browser-engine.ts:28-31,60` guards are removed with real behavior. |
| `MUB-4C` | P2 | Deep wiring, timeline, Reference view | DEFER | Gated on MUB-3A/3B/3C. |
| `MUB-4D` | P2 | Simple Precise/Organic/Elevated + Depth/Presence | MODIFY (calibration step 7) | Aurialis design, not Waves coefficients; zero intensity neutral; order-commutative; bounded per spec §6. |
| `MUB-4E` | — | Loudness-matched A/B toggle | DECLINED | Conflicts with recorded owner decision (spec §2). The owner may reopen this explicitly. |
| `MUB-5` | P2 | Genre matrix (blueprint §4) | MODIFY | Keep the conservative recipes in `docs/mastering-controls-research.md`. Blueprint values are candidates only. Section-move caps: ≤+0.8 dB EQ, ≤+8% width, ≤+0.5 dB drive delta; all profiles ≤ −1.0 dBTP (grammy-veteran-1). |

Recommended next command after MUB-0 merges: `/war-room-loop feature=wasm-dsp` (MUB-2A), with MUB-4A as a parallel non-overlapping frontend slice.

## Iteration Log

| Iteration | Date | Scope | Active Seats | Outcome |
|---|---|---|---|---|
| 0 | 2026-10-20 | Initial War Room & Multi-Model Agent Architecture Setup (Gemini Argon, Claude Code, OpenAI Codex) | `aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Seeded multi-model War Room roster, `/war-room` & `/war-room-loop` skills/commands, HCL/OKLCH & mobile-first rules, Postman/Newman + cURL QA protocol, and initial `WASM-1`…`WASM-10` product backlog. |
| 1 | 2026-10-21 | Vertical Slices Implementation & Verification Wave (`feat/war-room-iter1-vertical-slices`) | `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Initial vertical slice scaffold: single Go binary embedding (`cmd/aurialis`), Audio CDR, 5-profile mastering engine, 2–6 stem separation, Next.js 16 warm editorial workstation (9 routes), client DSP & WAV export, control-isolation tests, Newman TS-001..TS-015 + curl probes, Playwright a11y/responsive suites, and unconditional CI pipeline. |
| 2 | 2026-10-21 | Historical activation claim — withdrawn: 100% Vertical Slice Activation & Honest Verification (`war-room/iter2-validation`) | `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Slices S1..S7 fully activated without placeholder wrappers: Simple mode (`mapSimpleToDSP`), Deep mode (`mapProfileToDSP`, `DeepTimeline`, `MoveEditor`), Loudness-Matched A/B (`RealTransport` RMS auto-trim), Smart Split (`SplitView` 2-6 stems), Albums (`AlbumView` sequence reordering & batch normalization), Reference Match (real EQ contour overlay & delta mapping), Release Check (objective platform targets for Spotify/Apple/YouTube/SoundCloud/CD/Podcast). All 14 Playwright tests, Newman TS-001..TS-015, Go race tests, and frontend linters pass. Status: `implemented — open, awaiting merge`. |

---

## Active Backlog (`P0` / `P1` / `P2` / `P3`)

Acceptance criteria below retain the intended product scope. Test-plan columns name required evidence.

| ID | Priority | Area | Title | Acceptance Criteria | Test Plan & Evidence Tier | Docs Impact | Status |
|---|---|---|---|---|---|---|---|
| `WASM-1` | **P0** | `go-backend` / `git-ci` | Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers | `pnpm run build:binary` produces a single binary serving Next.js 16 static export (`internal/webui`), `/health`, and `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers; flags `-addr`, `-workers`, `-max-upload-bytes`. | `go test -race ./...`, `curl -i http://127.0.0.1:<port>/health`, `TS-001` (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md`, `docs/api.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-2` | **P0** | `nextjs-ui` / `a11y-hcl` / `mobile-responsive` | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` | `src/app/globals.css` defines HCL/OKLCH-calibrated warm paper/ink/clay/moss/ochre tokens; zero external icon libraries; mobile (`320px–390px`) renders top bar + 4-item bottom nav + sticky mini-transport; desktop renders left rail + canvas + right inspector; all touch targets `>=44×44px`; WCAG 2.2 AA contrast verified. | `pnpm run lint`, `vitest` (Icon test), Playwright `320px`/`375px`/`768px`/`1024px`/`1440px` + axe WCAG 2.2 AA (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `open — awaiting merge (corrective subset locally verified; broad requirements tracked separately)` |
| `WASM-3` | **P0** | `wasm-dsp` / `audio-verify` | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge + War-Room Audio Transformation Verification Suite | Compiles `public/wasm/aurialis-dsp.wasm` implementing ZDF/TPT 5-band parametric EQ, program-dependent optical/FET/VCA compressor with 90 Hz sidechain HPF, 4× oversampled True-Peak limiter, ADAA tube/tape/transformer saturation, Linkwitz-Riley mono-bass + M/S width, and TPDF dither. Audio verification suite confirms physical accuracy. | `go test -race -v ./wasm/... ./internal/audio/...`, `orthogonality_test.go` (`wasm-bridge`, `unit`) | `docs/architecture.md`, `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-4` | **P1** | `go-backend` / `security` / `qa-newman` | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security (`aurialis-security`) | Bounded worker pool with `context.Context` cancellation; Audio CDR strips all non-audio chunks/trailers and rejects polyglots (`MZ`, `ELF`, Mach-O, `PK\x03\x04`, `%PDF`); zero user-filename disk writes (in-memory Float32 PCM buffers); `413` size cap; CRLF/path-traversal sanitization; `Host` & `Origin` DNS-rebinding/CSRF defense; `DELETE /jobs/{id}` idempotency. | `go test -race ./internal/...`, Newman `TS-001`…`TS-015` + raw `curl` 413 & DNS-rebinding probes (`newman-e2e`, `api-curl`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-5` | **P1** | `nextjs-ui` / `mobile-responsive` | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) with reusable primitives | Click, drag/drop, keyboard, and paste upload; media metadata validation; IndexedDB `projects` + `audio` Blob stores with fallback warning; mobile card view + desktop editorial table reusing `Button`, `StatusBadge`, `DropZone`, `Modal`. | Vitest + Playwright upload/library persistence & responsive specs (`playwright-a11y-responsive`) | `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-6` | **P1** | `wasm-dsp` / `nextjs-ui` / `mobile-responsive` | Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and WAV export (16/24/32-bit + TPDF dither) | Draggable 5-band SVG EQ with accessible numeric inputs and text summary; reducer control isolation (`src/lib/store.tsx`); shared Go DSP processing and 16/24-bit dithered PCM or 32-bit float WAV export; mobile accordions vs desktop right inspector; Simple mode mapping; loudness-matched A/B preview. | Vitest `control-isolation.test.ts` + Playwright `control-isolation.spec.ts` & `audio-export-verify.spec.ts` (`playwright-a11y-responsive`, `unit`) | `docs/architecture.md`, `docs/tasks.md` | `open — awaiting merge (corrective subset locally verified; broad requirements tracked separately)` |
| `WASM-7` | **P1** | `ai-mastering` / `nextjs-ui` / `mobile-responsive` | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline | Go backend + WASM engine generates & applies schema-valid v1 `MasteringScript` across 5 profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`) and UI aliases; staged progress; 5 automation lanes; mobile scrollable timeline with sticky lane labels; accessible text summary; `MoveEditor`. | Go `mastering_test.go` + Newman `TS-003` + Playwright Deep mode spec (`newman-e2e`, `unit`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-8` | **P1** | `go-backend` / `nextjs-ui` / `mobile-responsive` | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector & "Send to mastering" | Exact `2`, `3`, `4`, `5`, `6` stem mappings; validated source separation; per-stem mute/solo/level/pan/rename reusing `SliderField` and `Toggle`; stem audio downloads (`/jobs/{id}/stems/{stem}`); handoff to mastering. | Newman `TS-002`, `TS-013` + Playwright Smart Split spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-9` | **P2** | `nextjs-ui` / `go-backend` / `mobile-responsive` | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | Album track ordering (Move Up/Down), batch normalization & consistency SVG chart; Reference Match dual-curve SVG overlay & spectral delta mapping; Release Check across Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast with compliance audits. | Playwright responsive & navigation journeys across all 9 routes (`playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-10` | **P1** | `git-ci` / `qa-newman` | Unified GitHub Actions CI/CD pipeline (`ci-cd` gate) | Unconditional execution of all quality gates in `.github/workflows/ci.yml`: repo/agent hygiene, Go/WASM quality gate, Next.js/TS frontend quality, Newman PR suite (`TS-001`..`TS-015`) + raw curl probes, and Playwright a11y/responsive checks. | `.github/workflows/ci.yml` unconditional configuration (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md` | `open — awaiting merge (remote source CI passed at e91d2f0; live PR checks show newer commit status)` |

---

## Recovery backlog — current session

The corrective subset passed current-session QA and Devil’s Advocate review and is open — awaiting merge. Rows distinguish repaired behavior from full feature requirements that remain open; removal of simulated outcomes is not delivery of analysis, automation or separation.

| ID | Priority | Required recovery | Status |
|---|---|---|---|
| R-01 | P1 | Integrated local startup with Go APIs and isolation headers | open — awaiting merge (integrated local startup locally verified) |
| R-02 | P1 | Repeatable binary build with a read-only previous runtime | open — awaiting merge (repeat builds/runtime replacement and empty-directory smoke passed) |
| R-03 | P1 | First apply uses current settings, preview/export agree | open — awaiting merge (immutable apply, source readiness and preview/export PCM passed) |
| R-04 | P1 | Source-derived Deep analysis; remove invented findings meanwhile | open — invented findings removed; static profiles locally verified, source-derived analysis not delivered |
| R-05 | P1 | Shared sample-timed automation and effective repair | open — misleading timeline removed; shared operational automation and repair not delivered |
| R-06 | P1 | Validated stem audio, controls, downloads and handoff | open — fabricated stem completion removed; validated separation and handoff not delivered |
| R-07 | P1 | Measured album processing and actual output | open — awaiting merge (bounded actual album WAV subset verified; wider consistency/batch scope open) |
| R-08 | P1 | Measured reference matching and effective protection controls | open — EQ-settings blend and protection controls verified; measured spectral matching not delivered |
| R-09 | P1 | Measured, correctly labeled release diagnostics | open — awaiting merge (actual rendered diagnostics and JSON verified; certification not claimed) |
| R-10 | P1 | Current transport: A Processed default, B Original, shared clock, no Match level | open — awaiting merge (39-case suite, independent WASI output and pending-init fixes locally verified; owner approval absent) |
| R-11 | P1 | Independent move edits when real automation is delivered | open — stale simulated editor removed; real automation editing not delivered |
| R-12 | P1 | Every enabled audio setting maps independently to sample output | open — awaiting merge (42 native control pairs, 267 parity fixtures, 31 real UI/export pairs verified) |
| R-13 | P1 | Bounded full-song input capacity and visible current limits | open — finite 3/5-minute native capacity verified; general high-rate/browser memory and longer capacity open |
| R-14 | P1 | Complete canonical component/CSS migration | open — awaiting merge (active route styles and responsive generated states verified) |
| R-15 | P1 | Honest synchronized docs; no demo production state; output-based tests | open — awaiting merge (honest docs, empty production state and output-based tests synchronized) |
| R-16 | P2 | Figma identity, metric hierarchy and responsive controls | open — awaiting merge (identity, metric hierarchy, target geometry and hero sizing verified) |
| R-17 | P0 | Patched Go native/WASM/CI toolchain; green vulnerability gate | open — awaiting merge (Go 1.26.10 and vulnerability gate verified) |

---

## Verified & Merged

| ID | Priority | Area | Title | Merged Commit / PR | Verification Evidence |
|---|---|---|---|---|---|
| MUB-2A | P1 | wasm-dsp | Algorithm-1 compatibility, capability and latency foundation | `3886536` / PR #6 | 333 exact compiled fixtures; zero-buffered-latency/drain contracts; corrected six-job CI `39838476152` |
| MUB-3A | P1 | go-backend / nextjs-ui | Source-bound measured features and cancellable diagnostics | `3886536` / PR #6 | 22 Newman requests/27 assertions plus raw probes; 61 browser cases; independent coverage/cancellation review |
| MUB-4A | P1 | nextjs-ui / audio-verify | Supported EQ type/enable and limiter release controls | `3886536` / PR #6 | Native/live/export checks, mobile target geometry and six-width accessibility within the 61-case suite |
| MUB-3B / MUB-4C editor | P1 | deep-mastering / nextjs-ui | Source-bound proposal editor, acknowledged live/native schedule, recoverable Apply/Revert/Detach and finite/repeat epochs | `6154f87` / PR #13 | 382 local units, corrected 102 local browser cases, both exact-head Linux 102-case runs, seven required app checks and identical reviewed/merged trees; finite/cross-rate oracles remain scoped |

---

## Declined (Bloat / Out of Scope)

| ID | Area | Proposal | Why Declined |
|---|---|---|---|
| `D-1` | `nextjs-ui` | Import `lucide-react` or `@heroicons/react` for rapid prototyping | Violates the Low-Bundle, Zero-Icon-Library invariant; all icons must use custom inline SVGs in `src/components/shared/Icon.tsx`. |
| `D-2` | `go-backend` | Keep a separate Python FastAPI container alongside the Go binary in production | Violates the Single Self-Contained Go Binary invariant; all web serving, job orchestration, DSP, and smart AI/LLM mastering run in-house from the Go + WASM binary. |
| `D-3` | `nextjs-ui` | Desktop-only DAW layout that scales down via CSS `zoom` or horizontal scroll on phones | Violates the Mobile-First & Responsive Design invariant enforced by `aurialis-frontend` and `aurialis-designer`. |
| `D-4` | `a11y-hcl` | Dark-mode / neon plugin theme switcher | Contradicts the warm editorial paper studio aesthetic (`docs/design/aurialis-redesign.md`) and doubles token maintenance. |
| `D-5` | `wasm-dsp` | Duplicate DSP filter math in TypeScript alongside Go/WASM | Unnecessary maintenance bloat; share one pure-Go DSP core (`internal/audio/dsp`) between native Go (`cmd/aurialis`) and WebAssembly (`wasm/dsp`). |

---

## Historical iteration 1 record

The original implementation commit history is retained in git (`8470405`, `f565ab3`, `3049756`, `421acca`, `41386c8`, `587731f`, `3875075`, `5e07560`). Earlier prose claiming complete vertical slices and calibrated processing was inaccurate and is superseded above. No historical test result is promoted to current-session evidence.

## Historical corrective loop — 2026-10-21

This earlier corrective session used its own iteration counter (maximum 10), separate from the historical iteration 1 above. Rulings are sequential review/implementation waves; specialist work can overlap. Go/static integration evidence is at `24137c4`; the final browser/frontend/build checkpoint is `c3c15c9`. The session stopped at its maximum 10 iterations with corrective changes verified locally and the full product scope still open.

| Session iteration | Ruling / work | Current evidence and remaining action |
|---|---|---|
| 1 | Establish pessimistic baseline and inspect checkout | Local main lacked the implementation; no scaffold was mistaken for the user's feature branch. |
| 2 | Discover/fetch the user branch and audit actual behavior | Continued from `9880481`; identified synthetic export, raw playback and unsupported workflows. |
| 3 | Establish DSP boundaries and shared WASM behavior | Strict parameter/safety and real compiled WASM/native parity fixtures; hardware/true-peak promises withdrawn. |
| 4 | Restore uploaded source preview and export | Advanced workflow uses actual canonical source, offline WASM preview and native export; unsupported workflows show unavailable states. |
| 5 | Harden parser, server and resource admission | Strict WAV/AIFF parsing, frame/request/concurrency/job limits, local authority checks and artifact cleanup. |
| 6 | Verify packaging and toolchain | Fresh binary build and empty-directory embedded-asset smoke passed before final integration; Go patch and local font packaging updated. |
| 7 | Strengthen QA and execute strict gates | 11 Vitest tests passed. First 14-case browser run: 6 passed, 8 failed (six axe search-input size cases, modal focus, uploaded-audio timeout); failures drive follow-up fixes. |
| 8 | Correct metering and automation | Gated loudness and finite-FIR peak measurement passed 15 independent FFmpeg comparisons; native automation gained validated envelopes and cancellation without hidden target gain. Limiter/AI/hardware boundaries remain explicit. |
| 9 | Browser/accessibility fixes and revalidation | Second 14-case browser run: 7 passed, 7 failed (six active A/B contrast cases and blob CSP). Fixes landed, alongside keyboard focus and float headroom regressions; final 14/14 browser rerun passed at `c3c15c9`. |
| 10 | Final integrated gates and blockers | Integrated `24137c4`: Go static/race gates, TypeScript/lint/knip, 13 Vitest tests, 15 compiled WASM parity fixtures, fresh binary build/smoke, agent sync, actionlint and cspell passed. Final API run passed 17 requests / 22 assertions plus raw 413/Host probes. A further browser run passed 11/14, revealing tablet navigation names; labels were fixed and the final run passed 14/14 at `c3c15c9` across six viewport sizes and eight routes. Final lint, fresh binary build and empty-directory smoke passed again. Vulnerability database access blocked. No verified completion, merge, release or green remote CI assertion. |

Preliminary evidence is also listed in [`docs/tasks.md`](../../docs/tasks.md). Final command outcomes and checkpoint SHAs are recorded in tasks above; the five owned documentation files passed cspell, local-link validation and diff whitespace checks before commit. QA accepted signed-zero normalization without weakening finite-sample checks; Devil's Advocate found no demonstrated corrective-PR blocker. No historical or preliminary result is promoted to a final passing gate.

The pending-preview track-switch concern was ruled out by code inspection: MasterView is keyed by resolved track ID, so changing tracks remounts it and unmount cleanup aborts pending rendering. This historical checkpoint retained unsupported processing workflows and a blocked vulnerability gate. The recovery record below supersedes its current-state claims; history is not final recovery evidence.


## Earlier corrective loop — four iterations

The user authorized corrective implementation after the baseline review. This recovery counter is separate from the earlier ten-iteration history. All broad `WASM-1`…`WASM-10` requirements remain open; disabled unsupported features do not satisfy their acceptance criteria.

| Iteration | Ruling and implemented subset | Evidence and remaining gate |
|---|---|---|
| 1 | Reproduce and rule on the 17 baseline findings; compare the corrected archive with canonical design assets | Baseline `ade7736` failures are preserved in the audit. Only `main` existed locally/remotely at review start. |
| 2 | Correct integrated startup/runtime replacement; patch Go; remove demo/simulated results; restore real Advanced/Simple processing, profiles, album WAV artifacts, reference settings blend and native release diagnostics | Atomic source changes integrated on `codex/war-room-product-audit`. AI analysis, real time automation, trained separation and spectral matching remain open. |
| 3 | Reuse Tailwind controls/dialogs/modules; restore Figma structures and responsive hero sizing; add high-pass, source-rate EQ, independent control and finite-capacity regressions | 267 native/WASM fixtures and 42 control pairs are the audio checkpoint scope. Simple mapping starts from neutral defaults; 36 genre/tone regressions prevent repeated Apply from compounding settings. Reference curves share logarithmic axes and retain measurement provenance. Representative 3/5-minute native requests and canonical round-trip passed; observed memory is not a universal or browser budget proof. |
| 4 | Final integrated static/native/browser/packaging/API/documentation review | Initial 12-pass/8-fail browser evidence exposed a real Simple solver defect and metric-strip keyboard-focus failures; deeper probes found 41.25 px targets and an early profile-Apply race. All gained fixes and regressions. Corrected source passed 69 unit tests, full Go race, 267 fresh native/WASM fixtures, static/build/smoke gates, final 27-case browser suite (174.288 s), 31 UI control pairs/62 WAV exports, nine independent workflows, 30 generated axe/overflow views, hero/low-rate output probes and Newman 17-request/22-assertion coverage. Corrective subset locally verified and open — awaiting merge; remote CI passed at `40d2503`; owner approval remains outstanding and live PR checks show newer commit status. Full failure history and precise checkpoint scope are retained in `docs/tasks.md`. |

See [`docs/tasks.md`](../../docs/tasks.md) for the finite capacity, per-control coverage and checkpoint evidence. The earlier failed/blocked attempts remain historical evidence and are not erased by later successful reruns.


### Remote CI hygiene follow-up

The [initial PR #2 CI run](https://github.com/yegamble/aurialis-WASM/actions/runs/39551701995) failed `scripts/sync-agents.py --check` because the generated plugin rule mirror retained Go 1.26.2 instead of canonical Go 1.26.10. Regeneration changes only that mirrored version line; the local synchronization check then exited 0 for all 11 agents. Application code is unchanged. All six jobs in the [corrected remote run](https://github.com/yegamble/aurialis-WASM/actions/runs/39552061335) succeeded at `40d2503668a2379e4677562aed9f46448d53e585`. Remote CI passed at `40d2503`; [live PR checks](https://github.com/yegamble/aurialis-WASM/pull/2/checks) show newer commit status. Owner merge and full-product delivery remain open, so PR #2 stays **open — awaiting merge**.


## Current live playback follow-up

The user’s updated contract supersedes the old A-original/B-processed labels and RMS Match level control. **A Processed** is now the default, **B Original** is the aligned dry path, and automatic gain matching is removed. Shared Go DSP runs in a worker behind a bounded SAB bridge; the worklet stays nonblocking. Approximately 80 ms aligned dry/wet buffering and an 8 ms transition retain one playback clock. Meters and the 4096-point L/R power-mean FFT describe audible output; the warm live spectrum is primary and the compact Advanced EQ remains an editable settings view.

Simple tone changes and static profiles update the live chain; explicit Simple Apply separately prepares measured target settings for export/offline preview. Strict cached canonical loading, contextual request/body errors, source retry and fresh graph ownership address recovery paths. Native export keeps the source rate; live device-rate resampling prevents a cross-rate sample-identity claim.

Runtime `0265eba`, frontend `4562a99` and configured-chain warm-up `602e239` are integrated. At the preceding live checkpoint, Go/static/race gates, TypeScript/lint/knip, 87-file spelling, 91 unit tests, fresh binary/smoke, 267 native/WASM fixtures and Newman 17-request/22-assertion checks all exited 0. The full 30-case Chromium suite passed, including actual live destination output, a fixture-bound under-250 ms parameter assertion, six axe/geometry widths, cached-return recovery, same-file import retry and 31-control/62-export PCM checks. Exact numeric UI latency was not retained by that list reporter; the 31 controls refer to offline exports, not 31 live captures.

Independent integrated Chromium/Brave checks passed all eight groups per browser with zero total observed underruns, preserving 79.979 ms/99.9984% of a final 80 ms tone tail. The separate controller harness passed 24 source/device/chain configurations after warm-up. Earlier CPU-contention failures (3/25) remain in history; passing serial fixtures do not certify arbitrary-host real-time performance. The independent app binary was VCS `602e239` with `modified=true`, SHA256 `8560804c7680682006d9027718043d94391ed544c3bb9cd1d5c8453ee473937f`, not a clean release assertion. Detailed coverage and limits are in `docs/tasks.md`.

### Round D — accepted live corrections

```text
DECISION: ACCEPT — generation reset, cold-start warm-up and source lifecycle repairs
WHY: A delayed duplicate generation reset could rewind active worker state. Idempotent reset guards and a VM regression address that race. Bounded configured-chain warm-up runs before source playback and resets its history; independent destination-output probes retained the delayed tail and observed zero total underruns in the recorded cases. Fresh graph disposal/retry and same-file import recovery now have actual browser coverage.
DISSENTING VIEW: QA limits zero-underrun and latency findings to measured fixtures under serial CPU conditions. Block-boundary parameter changes do not certify continuously smoothed controls or musical automation. The original fetch failure remains undiagnosed.
AFFECTED LAYER: wasm-dsp | nextjs-ui | mobile-responsive | a11y-hcl | qa-newman
USER / AUDIO IMPACT: A Processed is the default, B Original stays aligned, settings reach live shared DSP, and return navigation/retry restores playable output.
BUNDLE / TEST IMPACT: Reuses the Go core and shared controls; adds bounded worker/worklet state and actual destination-output/cancellation regressions rather than a second DSP implementation.
ACCEPTANCE CRITERIA: Current local signal/lifecycle/UI checks pass; no original-source substitution or fabricated meter state; unsupported AI/separation/automation promises remain open. The elapsed-label follow-up and next remote CI checkpoint still need their recorded outcomes before integration closure.
TEST PLAN: Full 30-case Chromium suite; independent eight-group Chromium/Brave output probes; 24 controller rate/chain configurations; native/WASM parity, static/race/API/packaging gates; final focused elapsed-label build and additional Brave durable run.
DOCS TO UPDATE: README.md, docs/api.md, docs/architecture.md, docs/tasks.md, .claude/war-room/ledger.md
```

That 30-case checkpoint predates the elapsed-floor, expanded transport/import and canonical-settings follow-ups. Later proof is recorded below; it does not retroactively change the executing artifact of earlier tests.

The original “Failed to fetch” cause remains **UNVERIFIED** despite successful fresh POST probes. Do not label the contextual error or cache changes as a proven diagnosis. The broader AI/separation/automation/certification backlog remains open. PR #2 is **open — awaiting merge**, with owner approval and the final UI-only/Brave/remote-CI follow-ups still required.


### Expanded follow-up — transport, repeat, import

The user’s spectrum/transport polish scope extends beyond the preceding live checkpoint. Implemented changes include animation-frame transitions between measured 20 Hz FFT traces, a reserved status row, responsive full-width transport, canonical slider/EQ resets, restart-at-zero, queue-aware Next (otherwise a ten-second forward seek), cancellable hold scrubbing, repeat at the audible source boundary, and current-player keyboard/Media Session ownership. Holding is distinct from tapping; playback resumes according to prior intent and stays stopped at the end without repeat. Subsequent independent repeat/hold/media/reset and focus/EQ/Next probes passed in both browsers; the newer canonical-target/full-suite outcome remains pending. Visual interpolation is not a higher FFT measurement rate or fabricated audio data.

Import now performs one bypass/32-bit POST, returning canonical PCM and the shared source measurement schema in an at-most-4096-byte `X-Aurialis-Source-Metrics` header. Exact Content-Length and client header/byte/rate/frame checks guard transfer consistency; native CDR, request/frame caps and timeouts are unchanged. The bypass path reuses one native measurement and decoded PCM. UI phases distinguish validation/reconstruction, waveform preparation and saving, with cancellation guards. Malformed-header response cancellation has focused coverage; actual processing/transfer cancellation and retry outcomes are recorded below.

The earlier five-user-WAV Brave baseline (approximately 35–47 MB each) passed in observed 17–36.5 s with peak native RSS 676 MiB. It predates this import optimization and does not prove improved speed, a universal memory cap or the original fetch failure’s cause. A preceding expanded unit checkpoint passed 113 cases and a later focused import run passed 40; neither is the final whole-scope gate. Build exited 0 for VCS `2612478` with dirty source including `cf99cfb`, binary SHA256 `8215f318bc8ed82f4068cd03516918a58c2680a0899e71a5b2b18fe88714a5d5`. This is an earlier integration artifact, not a clean release; later independent QA is recorded below.

**Ruling:** retain the preceding accepted live corrections and their bounded evidence; require fresh results for the expanded behavior before accepting its integration. Current runtime, full local gates and the next pushed CI are pending. The fetch cause remains **UNVERIFIED**. PR #2 remains draft and **open — awaiting merge**; owner approval and the broader product backlog remain outstanding.


### Current import evidence; shared Simple/Advanced correction pending

The new one-POST import passed five actual approximately 35–47 MB user-WAV Brave probes: 13.027 / 10.309 / 10.952 / 10.274 / 11.123 s, each one 200 response. Headers were 798–805 bytes and exact canonical bodies approximately 76–95 MB; first/last 256 converted frames matched the stored source. Cached reload produced destination PCM without another audio API request. Processing Cancel restored UI/admission in 246 ms; transfer Cancel yielded browser `ERR_ABORTED`, server broken pipe and admission release in 32 ms after an in-flight competitor received 503. The stream observer timed out after three seconds, so a clean stream-close observation is not claimed. Retry completed in 13.203 s with playable output. Observed native RSS was 340,803,584 bytes (about 325 MiB). These runs and the earlier 17–36.5 s/676 MiB baseline are not controlled speed or matched-memory comparisons. The original fetch failure remains **UNVERIFIED**.

Go 1.26.10 toolchain/format/modules/vet/lint/identifier/vulnerability/race/WASM gates all exited 0. A later frontend/build checkpoint passed strict TypeScript, lint, knip, 98-file spelling, 122 unit cases and build (SHA256 prefix `44642d22`, VCS `f70` with dirty source). This predates a later guard and the new shared-settings correction; it cannot verify them.

**Implemented canonical contract; final whole-suite proof pending:** Simple and Advanced edit one canonical chain. View changes preserve audio; genre/tone/intensity updates write that chain; custom Advanced edits mark Simple direction custom and clear misleading selections. Target-only updates retain unrelated settings. **Set target loudness** explicitly normalizes the current chain; exports use it independently of mode. Optional `Track.simpleCustom` records that state. Actual LUFS/ceiling values determine the named/Custom target selection; explicit direction changes preserve those canonical values. Existing Apply/export evidence remains historical for its tested checkpoint. Independent focus/EQ/visual evidence is recorded below; final whole-integration browser count, pushed CI and owner approval remain outstanding; PR #2 is **open — awaiting merge**.


### Latest local verification — canonical chain and startup guard

Canonical settings (`c4ee9fc`/`f101708`) and target truth (`ab111bb`) now preserve one chain across views. Explicit **Set target loudness** measures that current chain and commits input gain only if the snapshot is still current. Target-only changes preserve unrelated controls; named/Custom target selection follows actual limiter LUFS and ceiling. Dense waveform rendering (`c5172f3`) derives from 2048 actual peak buckets. The dormant worklet (`53bc`) remains inactive until reset, retaining active-generation missing-block failures and existing counters.

Current Go gates, 267 native/WASM fixtures, Newman 17 requests/22 assertions and raw security probes exited 0. Strict TS/lint/knip passed; a spelling failure on a new test identifier was corrected in `4ee79ce`. The rerun checked 101 files, passed 134 unit cases and exited 0 for build/standalone smoke. Latest integration binary SHA256 is `f32fe2231f13d9c5e10a11a97f74c3dde533aa00ac7b4e44f732933d1c8d40e9`, VCS `4ee79ce9b4394319a50c1350bc690d1a218584d8`, dirty source. Actual canonical-target normalization passed in Chromium (19.832 s) and Brave (12.666 s): two actual native 200 responses each, −12 LUFS target/−0.7 dBFS ceiling, input 0→4.014246984 dB, measured output −16.014246984→−12.00000000004 LUFS, sample peak −9.965944 dBFS, other settings unchanged. The complete durable suite has unresolved failures.

Independent Chromium/Brave checks passed Next/focus/EQ corrections, transport hold/repeat/media/reset and six-width controls on binary `44642d22c6482096f5124ae04e538be4ab24ab397fd162cbf852c170a0b6eec7` (VCS `f70cd9066e3fbdd7ee8f07be3bb379944ec98cad`, dirty). Later canonical/waveform/startup checks used `c9e8fd35928d2a8cd2cae644c2083f9b385c5b8302f51e845ad1fb4648f5365f` (`53bc`, dirty), preceding final target-dropdown repair. Four mode/output groups per browser passed exact settings/version/graph and 0.12 dB assertions; the fifth preset baseline failed and is retained. A narrow settling diagnostic observed approximately 0.14 dB drift before any mode change, then passed unchanged assertions after settling. Durable setup now waits two seconds; no tolerance was relaxed.

Both browsers passed waveform geometry at all six widths (102/124/130/247/201/299 bars, 1.500–1.516 px wide, 1 px gap, overflow 0). Visual spectrum cadence was approximately 60 Hz, underlying analyzer approximately 17–18 Hz and reduced-motion cadence approximately 17.5 Hz, measured over two 1.2 s windows (about 2.6 s playback total). All sampled total underrun counters were zero. Controlled delayed startup kept pre-reset queue/applied counters at zero and source-start/final underrun counters zero; onset/zero-run checks remain bounded by ScriptProcessor capture timing. Earlier 11-Brave/5-Chromium counter failures remain **unclassified**; the guard proves idle queue inactivity, not the cause of those events or safety under arbitrary CPU starvation. Original fetch cause also remains **UNVERIFIED**.

**Round D/E scope:** retain accepted live corrections; the canonical settings and dormant guard are implemented with bounded independent evidence. Hold final integration acceptance: the 37-case durable run ended **34 passed / 3 failed in 8.2 minutes**, including two axe contrast failures (375/1024 px) and a real shared playback stall with Infinity/stopped source. Contrast was caused by foreground/background color interpolation (intermediate `#a9a4a0` on `#bf988a`, 1.05:1); transition removal `67c1930` awaits fresh validation. The stall is independently reproduced and is not the earlier preset-baseline settling issue. Actual-target normalization passed in both browsers. PR #2 remains draft and **open — awaiting merge**; no owner merge approval or full-product certification is claimed.


### Blocking shared-stall investigation

Independent instrumented throughput reproduction exited 1 in both browsers on `f32fe223…`, at device rate 44.1 kHz (128-frame budget 2.90249 ms). Chromium stalled before manual settings; Brave stalled on entering Simple before any Rock/Clean update. Retained next-read input tags were valid, with no persistent generation/tag mismatch identified. Go-call p95 approached the quantum; occasional recorded calls reached 96 ms. This supports limited margin without establishing the stall’s cause: observer overhead, missing final telemetry batches and unrelated host scheduling remain limitations. No 30-second active Rock/Clean pass was achieved. The original uninstrumented failure remains separate blocking evidence; preset settling, Crisp and the original fetch cause are not proven explanations.

The bulk bridge is integrated as `b0b4250` (agent `4383c43`), diagnostics `048c76e`, preserving finite/type/frame/bounds/offset/input-snapshot/output-alias/shared-buffer/signed-zero semantics with an additional fixed 512 KiB scratch area. All Go/JavaScript-target gates and 267 expanded parity fixtures passed with maximum error 0. Typical benchmark calls improved but a 348.6 ms maximum outlier remains. The current binary is `3c268b6f846a50d0be93d7626255d370762f0a55c671b89864dacac6f91c299a`, VCS `048c76e1ee543584bbbf27bfb8d888856bb02e6e`, dirty. TypeScript/lint/knip, corrected 102-file spelling, 134 units, build and standalone smoke passed.

Actual sustained browser checks still **failed**. Instrumented Chromium stalled at 6.329 s/70 total underruns; Brave continued into the active stage but recorded 123. Unwrapped production-worker probes also exited 1: Chromium stopped at 33.5196 s/162 total, Brave at 35.8474 s/75. Both contexts closed, destination output became zero and the application reported a processing stall. Chromium READ paused approximately 122 ms with valid next-read tags, then remained 52–59 blocks behind after resuming. This rules out a persistent tag mismatch in that observed interval, without distinguishing computation from runtime/scheduler pauses. No production threshold, latency or counters were changed to hide failures.

**Ruling:** bulk transfer is implemented, not accepted as a stall cure. Canonical/contrast/full-suite reruns are deferred for exact coefficient caching and separately accepted lazy evaluation of a discarded Thick/Crisp saturation intermediate (Warm unchanged). Old-output parity, complete quality gates and fresh sustained/browser evidence are required. Causes of the original stall, prior intermittent counters and fetch report remain unproven. PR #2 remains **open — awaiting merge**.


### Direct-export candidate — integrated, acceptance pending

Root `c9929d3` integrates exact cache `6a5b328`, lazy unused Thick/Crisp intermediate `cbebfd5`, direct worker `759392d`, fixed Go exports `38cd394` and embedded-ABI gates. The predecessor cache/lazy binary `220829cd…` still exited 1: Chromium completed 30 seconds active Clean at zero total underruns, while Brave stalled at 4.0187 seconds/70 total with a closed graph and zero output. Valid tags and observer callback gaps did not establish a host-contention cause. Prior full-suite/bulk failures remain retained.

The current Go 1.26.10 interface exposes `aurialis_live_buffer` (four input/output channel addresses), `aurialis_live_process` (128 frames) and `aurialis_live_reset`. Channel buffers plus validated input scratch total 3 KiB. Typed views are bounded, aligned and checked so they do not overlap and refreshed after Go memory growth; shared Go Bridge/Engine, runtime, JSON controls and offline API remain. The approximately 80 ms lead, roughly 200 ms fatal threshold and counters are unchanged.

Native/offline/direct WASM exactly matched all 321 frozen pre-change fixtures (267 plus 54 corners); 48 helper expected-output fixtures passed. Native hot-path allocation was zero; a temporary actual-WASM probe reported zero Go allocations per direct block versus 26 on the callback path across 1000 warmed neutral/active blocks, then was removed. This is not a claim of zero browser/runtime allocations, hard real-time safety or a proven original cause.

Fourteen worker lifecycle cases and full TypeScript/lint/knip, 107-file spelling, 146 frontend units and build passed. Embedded smoke first failed a stale callback-marker assertion; replacing it with actual embedded WASM compilation/three-export/worker-ABI verification passed. Expanded offline/direct parity and Newman 17-request/22-assertion/raw security gates passed. Current independent QA artifact is binary SHA256 prefix `169bdf27`, VCS prefix `38cd394`, dirty source. Original-worker 30-second active playback passed in both browsers at 44.1 kHz with zero total underruns and actual destination RMS −19.315/−19.321 dBFS. The longer user-WAV run failed below; canonical/contrast and complete-suite results remain pending.

**Ruling:** direct worker is implemented, not accepted as a stall cure. Keep live sustained blocker, current full-suite, pushed CI and owner merge open. PR #2 remains draft and **open — awaiting merge**; full product/physical-hardware certification is not claimed.


### Longer direct-worker run — acceptance failed

Actual approximately 47 MB user-WAV Brave command exited 1 at about 180 seconds with 39 total underruns (approximately 113 ms aggregate missing quanta). Output remained finite/audible and no fatal stop occurred. First 171 windows through 179.151 seconds had zero counters; onset showed READ 62094 paused about 73 ms with valid next input tag and WAKE 1. The pre-screenshot state already contained 39, so screenshot capture is not established as the cause. The five-minute zero-underrun target was **not achieved** and the planned 210-second mobile capture was not reached.

**Ruling:** reject sustained acceptance for this artifact; preserve the two-browser 30-second passes as bounded evidence only. Runtime diagnosis/new-candidate proof and the complete 37-case suite remain pending. Buffering, fatal threshold and counters remain unchanged; no original-stall/fetch cause is proven. PR #2 remains **open — awaiting merge**.


### Scheduling candidate ruling — acceptance still blocked

Focused canonical/contrast checks on immutable `169bdf27…` passed in both browsers: strict unchanged 0.12 dB tolerance, exact modes/versions/graph and preview freshness, zero misses in those windows and eight axe checks. Keep that UI proof distinct from the longer 39-underrun user-song failure. The full 37-case suite is ongoing with transient Master overflow at 375 px awaiting designer diagnosis.

**Round D ruling:** implement worklet WRITE notification and a worker `Atomics.wait` wake lease with a cooperative 20 ms budget and 64-block limit, yielding regularly for JSON controls. The time budget is checked between Go calls, so an individual call can exceed it; this is not a hard latency bound. Idle bootstrap uses MessagePort; paused/idle must not retain a perpetual timer. Keep the Go DSP, approximately 80 ms alignment, roughly 200 ms fatal policy and total counters unchanged. This is a focused scheduling candidate, not a proven cause or accepted cure. Fresh sustained and full-suite outcomes are required; PR #2 remains **open — awaiting merge**.


### Full-suite outcome and contained-waveform follow-up

Immutable direct-worker `169bdf27…` full37 exited 1: **35 passed / 2 failed, 5.6 minutes**. The prior contrast/shared-settings failures passed; current failures were transient 375 px Master overflow and global 90-second large-file timeout after reload. This does not prove a separate 30-second readiness failure or a timeout cause.

Source diagnosis traced waveform overflow to its pre-measurement bar row without containment, missing Figma’s decorative `.wave-bars` clipping. `f03ebe9` adds local width containment/clipping while retaining the seek target/keyboard controls. Focused lint/spelling/diff checks passed without assertion/time changes; fresh runtime proof is pending.

A focused large-import rerun passed unchanged 90/60/30-second budgets in 42.237 s (36.625 s body): one 200 POST with 76,800,044-byte response, no second POST/errors/crashes; HTTP 5.99 s, upload/transfer 7.992 s, import navigation 18.551 s, initial ready 83 ms, reload navigation 661 ms, URL wait 3.845 s, reload ready 17 ms, IndexedDB/Blob reads 55/54 ms. Preserve the full-suite timeout as unclassified; the rerun is not evidence of its fix.

Scheduling `b236bf7` and waveform `f03ebe9` are pushed to draft PR #2. Scheduling’s 26 focused cases passed. New full static/unit/build, sustained five-minute, complete browser-suite and remote CI outcomes remain pending; owner approval and merge are absent. PR #2 stays **open — awaiting merge**.


### Worker continuation and exact CI lint follow-up

Current worker continuation `1e8e450` uses MessageChannel with ownership tickets rather than the preceding timer continuation. Queued stale tickets are ignored; disposal closes the ports; paused/idle state has no continuing wake task. The cooperative 20 ms budget and 64-block limit remain, checked between Go calls; a single Go call can overrun the budget. These are scheduling bounds, not a hard audio-latency guarantee. Fresh sustained/browser acceptance remains pending.

Exact CI golangci-lint v2.15.0 initially found two taint-rule failures absent from the older local default. Correction `1a7b1b5` logs interrupted audio responses as fixed event text only (`audio response interrupted`), removing raw transport errors and request-derived fields. An explicit operator-selected local baseline-fixture read has a narrowly justified G703 suppression alongside its existing G304 suppression; this is not an upload/request code path. Published v2.15.0 lint then exited 0 with zero issues; focused vet/race, stored 267+54 fixtures, formatting/spelling checks passed. HTTP/DSP/resource contracts are unchanged. Exact-HEAD remote CI remains pending.


### Current packaging / waveform verification

Binary SHA256 prefix `bb0f8798`: 156 unit cases in 14 files, build and empty-directory smoke passed; spelling checked 109 files including hidden paths with zero issues, and all 11 agents synchronized. No sustained/full-suite acceptance follows from these prerequisites.

Waveform before/after probe exited 0 on the current binary without audio playback: initial 512-bar 375 px document width changed from 563 px to 375 px; rapid 1440→320 resize with 299 preceding bars changed from 350 px to 320 px. Current rows fit at 309/254 px, with decorative overflow hidden and wrapper minimum width zero. This verifies `f03ebe9` against the reproduced geometry defect. Current isolated two-browser short/sustained and five-minute actual-song runs and the complete browser suite remain pending. PR #2 is **open — awaiting merge**.


### Current wake candidate rejected for strict live acceptance; CI green

Current binary `bb0f87989b9c51f3e7591631b1c42023cd5922efc90cfd9aede3da060caae1f1` / Go 1.26.10 / HEAD `1a7b1b5ccecf72137ffeedaf1e9242e87c6ea828` with dirty docs: strict original-worker command exited 1. Neutral/manual/Rock/Clean/views had zero misses, then active playback accumulated 15 Chromium and one Brave total misses at 44.1 kHz. Playback remained finite/audible without fatal stop. Valid next tags/WAKE 1 and later READ catch-up do not establish persistent lost wake or a proven computation/scheduling cause. Five-minute/background probes were not launched. Keep the earlier 39-miss song failure as separate history.

[Remote CI run 39588688393](https://github.com/yegamble/aurialis-WASM/actions/runs/39588688393) passed all six jobs at exact `1a7b1b5ccecf72137ffeedaf1e9242e87c6ea828`, including Playwright **37/37 in 1.9 minutes**, large-file case 9.8 s and overflow checks. Remote/UI pending status at this checkpoint is superseded by those results, not by strict-live acceptance. The live failure remains blocking.

**Ruling:** allow an isolated read-only WASI-reactor Go-DSP AudioWorklet feasibility probe and independent adversarial source review, with fixed numeric controls and no callback/wake crossing in the hot path. Architecture guidance motivates investigating a risk; it does not prove the current missed-block cause. No root application implementation or successful acceptance is claimed. PR #2 stays draft and **open — awaiting merge**; sustained acceptance and owner approval remain outstanding.


### Production WASI integration — implemented, packaged verification pending

Following isolated Chromium/Brave 30-second feasibility passes, production integration is authorized: Go `0645888` fixed 56-control facade, dual-build `d75b2b8`, frontend `3ff464d` and direct AudioWorklet/restricted host. The live kernel runs the same Go Bridge/Engine on the render thread; the former processing worker is removed. The existing legacy JS/WASM module remains for offline preview. Main-thread compilation precedes audible playback; a fresh reactor gets a positive clock seed/256-byte entropy packet. The host provides bounded initialization services only and rejects processing/control imports. Settings use a 464-byte shared packet (16-byte header/56 doubles) with one odd/even payload+version transaction, strict Go validation and no spinning/JSON/callback/wake crossing in the sample path.

Full Go/JS/WASI quality/security/race gates passed; actual frontend encoder→restricted host→compiled WASI matched all 321 frozen native fixtures exactly. Invalid controls preserve prior state/history. Native valid calls and an instrumented private WASI copy measured zero Go allocations across 10,000 control/process/reset/combined calls and zero processing host imports; the stats observer is not a production export. Cold initialization can allocate and these results do not certify all browser/runtime allocations or hard deadlines.

Prototype history: zero initialization clock caused confirmed Go fatal, corrected with positive seed. Brave per-sample `getChannelData` fixture overhead was corrected by caching two views; suspected teardown/privacy explanations were retracted. Final real-browser prototype commands exited 0 with actual gain/EQ/heavy output and normal teardown; coarse max 2/1 ms measurements are not quantum-deadline certification. These feasibility results do not supersede earlier production worker failures.

QA `98281ed` adds two WASI retry/cancellation cases, preserving the prior 37 contracts; 39 cases are enumerated and strict typing/spelling passed. The approximately 80 ms alignment, roughly 200 ms missing-output policy, transport, source resampling, generations/tags/APPLIED and cumulative counters remain. Without a worker boundary, zero queue counts cannot prove every render deadline; output-continuity/timestamps and coarse recording must be assessed separately. **Packaged 39-case and five-minute acceptance are not yet executed/pending**. PR #2 remains draft and **open — awaiting merge**.


### Packaged WASI checkpoint — bounded playback passed, final acceptance pending

Binary prefix `b3d71956` / source `a8267cd`: 162 units in 15 files, dual build, standalone smoke and 114-file hidden-path spelling passed. Actual packaged Chromium/Brave cold/manual/Rock/Clean/view transitions and 30-second active playback exited 0 at 44.1 kHz, finite/audible with zero retained counters. This is bounded signal/state evidence, not full long-output/deadline certification.

Five-minute actual-output recording remains pending. Blob recorder CSP rejection and a same-origin recorder 404 were observation-setup failures. A private localhost proxy adds the recorder module only, retaining original application/DSP bytes and CSP; no production policy weakening or runtime pass is claimed.

[CI 39594749277](https://github.com/yegamble/aurialis-WASM/actions/runs/39594749277) at `a8267cd` passed hygiene/Go-WASM/frontend/Newman, but browser execution was 37/39. The two new test failures came from a broad alert selector matching Next’s empty route announcer; actual retry/cancel contract failure was not established. Scoped selectors and a pending Media Session regression are in progress. Final 39-case/remote and long-output acceptance remain open; PR #2 is **open — awaiting merge**.


### Packaged WASI five-minute actual-song fixture — passed

Binary prefix `b3d71956`, private same-origin recorder proxy 3899→3848 with unchanged application/DSP/CSP bytes: actual approximately 47 MB/247.2-second Stand-In source repeated across its endpoint once. Command exited 0 after **301.06 seconds**, with nine gain/EQ/preset/A-B/mode/resize actions, 1440/375 screenshots, same graph/playing state, zero cumulative counters and 13,278,976 actual rendered frames. Recording retained all startup zeros (maximum 5049 samples/39 zero quanta); after first signal there were zero non-finite samples, raw/post-signal frame gaps or zero quanta.

The new observer’s earlier startup-gap assertion exited 1 and was classified as pre-first-signal graph construction, not silently waived; corrected raw-gap recording passed. Coarse Date.now maximum callback was 8 ms and is not a hard deadline or physical-device guarantee. Separate actual direct-port short runs passed in both Chromium/Brave; the long run is Brave-specific. Screenshots were visually reviewed for warm design/waveform detail.

**Round E scope:** accept this bounded recorded five-minute fixture, preserving all prior worker and observation failures. Current pending Media Session control correction/gates/build, corrected complete 39-case suite and exact-HEAD CI remain required. PR #2 remains **open — awaiting merge** with owner approval absent; no arbitrary-host, physical-hardware or full-product certification is claimed.


Separate Brave pending-init Media Session probe exited 1: pause during held WASI fetch was ignored, context remained running/loading after two seconds, and no source graph had started. Retain this actual control defect while its prepared fix proceeds through gates/build/actual-browser confirmation. The five-minute pass does not cover it. Two observed Brave 404 console messages have unclassified URLs; page errors were zero and output/source/reactor worked, which is not proof of zero resource failures. Corrected full39/exact-HEAD CI and owner merge remain open.


## Final corrective acceptance — source e91d2f0

Final artifact SHA256 `fa45eaa59a0c294b47d8794ba40280136ae207d5f74fc5220df8e78f47aace9e`, VCS `e91d2f0f9c1b40dadb416fbff69714daeeb31aef`, docs dirty. The latest pending-init correction `599098b` and alert-selector correction `e91d2f0` passed TypeScript/lint/knip and 164 units in 15 files, build and empty-directory dual-module smoke. Earlier unchanged-Go full quality/security/race/target gates, 321 frozen compiled fixtures and Newman 17-request/22-assertion/raw probes remain applicable at their recorded scope.

Fresh actual Brave Media Session/Space held-fetch pause/resume checks both exited 0: pause suspended and cleared loading, trusted replay resumed before fetch release, then one finite audible graph/error0/misses0. The original failed artifact remains in history. Local direct-port full suite **exited 0, 39/39 in 3.3 minutes**, including six-width axe/overflow/touch, 21-second >35 MB import/reopen, actual A/B/gain/EQ/FFT/meters, canonical modes, transport/handoff, cache/navigation, WASI 503 retry/cancellation and 31 independent GUI→native-export PCM effects. Those 31 exports are not 31 independent live captures.

The actual five-minute Brave song fixture passed 301.060 s/13,278,976 finite frames with repeat/actions/screenshots and all raw startup data retained. Its hot-path DSP/host/worklet source is unchanged in the final control-repair artifact; VCS metadata changes the compiled hash. Destination/render continuity does not certify physical speakers, arbitrary host scheduling or hard deadlines. Earlier observer failures and two URL-unclassified Brave 404s remain retained; the fresh short pending-init run had no page errors or captured HTTP errors.

All six source jobs in [remote CI 39597252997](https://github.com/yegamble/aurialis-WASM/actions/runs/39597252997) passed at exact `e91d2f0f9c1b40dadb416fbff69714daeeb31aef`. This is the recorded green source checkpoint; [live PR checks](https://github.com/yegamble/aurialis-WASM/pull/2/checks) show newer documentation-commit status.

Technical Writer final checks exited 0: repository spelling including hidden ledger/repo-map checked 114 files with zero issues, 48 local links resolve, and six-file diff whitespace checks are clean.

**Round E ruling:** the bounded corrective subset is locally verified and **open — awaiting merge**. Documentation is synchronized; owner approval and merge are absent. Keep broader AI/trained stems/automation/reference matching/album capacity/hardware and platform certification requirements open. Original fetch causation remains **UNVERIFIED**. No whole-product completion or merge is claimed.


## Starting-point activation feedback — 2026-10-22

DECISION: Derive Add Air, Cut Mud, Tape Warmth and Glue Comp highlights and accessible pressed states from their relevant canonical settings. Keep the existing idempotent apply behavior; do not add hidden toggle state or undo other module edits.
WHY: The controls applied settings but gave no persistent activation feedback. Independent matches may coexist, and relevant edits or bypass must clear a match. Source-rate-clamped EQ values must still match their starting point.
EVIDENCE: 186 unit tests; TypeScript, ESLint, knip and spelling; production build and standalone smoke passed. Five focused browser cases verified actual PCM changes, repeat idempotence, visible/accessible selection, keyboard, bypass/edit clearing, coexistence and persistence. Full Chromium suite passed 47/47 in 2.1 minutes. Devil’s Advocate review found no blocker. The first build inside the sandbox stalled; the permitted build rerun passed.
STATUS: open — awaiting merge.


## Reversible starting points and transport alignment — 2026-10-21

DECISION: Replace apply-only clicks with reversible per-shortcut toggles. Preserve unrelated controls and independent shortcuts, validate persisted restoration records, and clear stale ownership on preset/reset operations. Center the wide transport and simplify the skip icon.
EVIDENCE: 202 unit tests, frontend static gates, spelling, production build and standalone smoke passed; 13 focused browser cases passed. Full suite: 52/53 passed; the remaining 12 kHz fixture vanished at a 24 kHz device Nyquist frequency. Test-only correction to 7 kHz passed three repeated live runs. No full-suite repeat after that correction. Legacy mirror and identity issues found in initial unit checks were fixed.
STATUS: open — awaiting merge.


## CI live-audio baseline correction — 2026-10-21

Run 39711192709 passed every gate except the Add Air live test (52/53 browser cases). Its fixed theoretical RMS assertion expected -9.49 dBFS but the Linux speaker feed measured -10.098 dBFS. The test now measures B Original on the same device, verifies neutral A Processed matches within 0.1 dB, then retains independent activation changes and restoration within 0.1 dB. A bounded original level check still rejects silence or excessive gain. Application processing is unchanged.

Verification: full local Chromium suite **53/53 passed (2.3 minutes)**; TypeScript, repository lint and changed-test spelling passed. Direct ESLint invocation on the E2E file reported that E2E files are excluded; the configured repository lint passed afterward. Remote CI rerun pending. Status: **open — awaiting merge**.


## WASM DSP validation and transition follow-up — 2026-10-21

Scope: `/war-room-loop feature=wasm-dsp`, owner-gated merge. Work continues in isolated integration branch `codex/wasm-dsp-verification` based on current `main` merge `97964fc`; the shared checkout changed during review and was left untouched.

### Round D — DSP JSON array shape

DECISION: ACCEPT — P1 required correction.
WHY: QA reproduced an oversized `Bands` array bypassing the exact-key check while Go's case-insensitive struct decoder accepted it and truncated the extra band. Apply the existing shape checks to every accepted case variant, including multiband and nested band keys.
DISSENTING VIEW: Broad canonical-casing enforcement and duplicate-key parser changes were declined; they would change unrelated API behavior. Identical duplicate keys retain existing last-value semantics.
AFFECTED LAYER: wasm-dsp, go-backend.
USER / AUDIO IMPACT: Reject malformed settings instead of silently interpreting a truncated array; preserve active settings and bridge history after rejection.
BUNDLE / TEST IMPACT: No production dependency or browser bundle change; targeted Go boundary tests.
ACCEPTANCE CRITERIA: Every supplied EQ alias has five complete bands, every multiband alias has three complete dynamics bands, and malformed array shapes cannot be hidden by correctly shaped aliases. Numeric ranges are checked after final decoded alias resolution.
TEST PLAN: Focused count/completeness, alias and rejection-state tests; fresh Go/WASM, frontend, packaging, API and browser gates.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

### Round D — saturation transition evidence

DECISION: MODIFY — retain the initial defect evidence; verify the existing repair and strengthen regression coverage.
WHY: The initial continuous-ramp probe measured a 90.408226 Thick saturation sample on an amount change from 40 to 41. The current source already contains antiderivative-history rebasing; the replay measured approximately 0.0069. This loop does not claim to implement that existing production correction.
DISSENTING VIEW: A whole-engine reset, new smoothing framework, extra oversampling or limiter masking was declined as unnecessary for the quotient-history defect.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Guard against reintroducing artificial impulses when a saturation curve changes while preserving unrelated stage history.
BUNDLE / TEST IMPACT: Focused continuous-ramp tests; no production algorithm change from this item.
ACCEPTANCE CRITERIA: Small drive edits, directed character transitions and inactive updates remain finite and bounded around the antiderivative fallback thresholds; unchanged/rejected updates preserve state.
TEST PLAN: Native regression and compiled bridge parity; distinguish these bounded fixtures from hardware, alias or universal smooth-automation certification.
DOCS TO UPDATE: Architecture, tasks and this ledger.

### Round E — fresh integration checkpoint

Source: `1126fa5`, including JSON correction `eb78aab`. The Chair observed full Go race/module/vet/identifier/vulnerability gates and local lint 2.6.2 exiting 0; exact CI lint 2.15.0 also exited 0 with zero issues. Formatting output was empty. Compiled JS-target saturation transition/allocation tests and compiled bridge JSON-rejection history checks passed. Native/legacy/direct/restricted-WASI parity passed all 333 fixtures with exact output, maximum error 0. Production binary build and standalone empty-directory smoke passed. TypeScript, frontend lint, knip and 202 units in 17 files passed; configured spelling checked 125 files with zero issues.

Retained setup failures: the first build used an external dependency symlink and failed; a locked installation inside the isolated checkout resolved it. An extra all-hidden-files spelling scan found 183 preexisting dictionary issues across 41 files, outside the configured passing gate. The first API run used the skill's 200 MB override and failed startup validation against the supported maximum of 135266304 bytes; the default-limit rerun passed with 17 requests, 22 assertions and raw DNS-rebinding 403/upload-limit 413 probes.

Direct binary curl probes returned 200 for valid uppercase EQ/multiband arrays and 400 for oversized, undersized and differently cased masked arrays. The first multiband probe omitted required crossover values and failed its expected-200 assertion; adding 200/4000 Hz crossovers made all four multiband probes pass. The complete Chromium suite exited 0: 53/53 in 3.9 minutes, including six-width axe checks, live effects, 62 control/export comparisons and a 30.9-second large import. Agent synchronization passed for all 11 definitions.

**Round E ruling:** QA and Devil’s Advocate accepted the focused JSON validation correction and saturation regression coverage with no new in-scope P0/P1 defect. Technical Writer confirmed the five documentation surfaces match the integrated diff. The bounded follow-up is locally verified; **open — awaiting merge**. Owner merge and remote CI remain pending; broad hardware, alias, true-peak and all-settings automation certification remain open. Prior gate results elsewhere in this ledger remain historical.


## WASM DSP stage history, recovery and packet follow-up — 2026-10-21

Scope: `/war-room-loop feature=wasm-dsp`, current PR #4 integration branch after `main` at `1dcbed7` was merged as `2ee7b1e`. The prior JSON/saturation-test wave and its historical gates remain intact. Both remote runs at its documentation checkpoint passed: [39715091775](https://github.com/yegamble/aurialis-WASM/actions/runs/39715091775), [39715070466](https://github.com/yegamble/aurialis-WASM/actions/runs/39715070466). These are prior-wave results, not acceptance of the changes below.

### Round D — discard inactive stage history

DECISION: ACCEPT — P1 required correction.
WHY: Native probes found frozen history replaying old audio after more than one second of disabled silence: EQ peak 2.758, saturation 0.078, mono-bass 0.207, De-Harsh 0.048 and multiband 0.181.
DISSENTING VIEW: A whole-engine reset on every edit or a new smoothing framework would discard unrelated state and expand the repair unnecessarily.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Clear state owned by the deactivated or neutralized module/band/subpath so later activation cannot resurrect that frozen audio; preserve unrelated processing history.
BUNDLE / TEST IMPACT: Stage-local state handling and targeted native/compiled transition regressions; no new dependency or constant-setting algorithm replacement.
ACCEPTANCE CRITERIA: After active input, disabled silence and reactivation, affected paths do not replay the old signal; unrelated state and steady-setting outputs remain covered independently.
TEST PLAN: Module, EQ-band and subpath deactivation/neutralization tests; native/JS/WASI fixtures, allocation checks and integrated browser output.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger as behavior warrants.

### Round D — failed initialization after Pause

DECISION: ACCEPT — P1 required correction.
WHY: Pause invalidated the original Play ticket, so its failure guard skipped cleanup and the next Play reused a rejected initialization promise.
DISSENTING VIEW: Replacing the audio controller or changing navigation ownership is unnecessary; retain promise ownership for cleanup separately from current audible intent.
AFFECTED LAYER: nextjs-ui, wasm-dsp.
USER / AUDIO IMPACT: A failed paused initialization releases its graph and promise; the next trusted Play can retry, and stale failures cannot tear down a newer attempt.
BUNDLE / TEST IMPACT: Existing controller ownership logic and focused unit/browser failure-retry tests.
ACCEPTANCE CRITERIA: Hold WASI initialization, Pause, fail it, then Play once; a fresh successful attempt becomes audible without stale cleanup disposing it.
TEST PLAN: Deferred initialization rejection unit cases and actual held-fetch/503 browser regression.
DOCS TO UPDATE: README, architecture, tasks and this ledger.

### Round D — validate numeric packet shape before publication

DECISION: ACCEPT — P1 required correction.
WHY: Two multiband entries encoded 76 values and retained stale trailing controls. Four encoded 86 values and could throw after publication began, leaving an odd sequence that subsequent updates could not recover.
DISSENTING VIEW: Current hydration/UI preserve three bands; this is a reproduced runtime boundary defect, not a demonstrated ordinary GUI failure.
AFFECTED LAYER: wasm-dsp, nextjs-ui.
USER / AUDIO IMPACT: Require exactly three multiband bands and 81 finite values before opening the transaction; rejection preserves payload/version/sequence and later valid updates remain usable.
BUNDLE / TEST IMPACT: Two shape guards and focused packet/state tests; numeric ABI and dependency count unchanged.
ACCEPTANCE CRITERIA: Two/four-band packets reject before mutation, and a subsequent valid packet publishes normally.
TEST PLAN: Encoder and shared-buffer transaction regressions, frontend static/unit gates and compiled numeric-ABI parity.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

DEFER — P2: Native cross-output aliasing has no demonstrated application caller. No generic overlap abstraction is added in this wave. Version 2/hardware-parity blueprints remain specifications only.

### Iteration 2 — stage acceptance reopened

VERDICT: INCOMPLETE — SEND BACK TO WAR ROOM LOOP.

QA and Devil’s Advocate independently found that `d7146a2` still retained model-local shaping histories while another saturation model was active. Crisp→Thick, more than one second of zeros, then Crisp produced an approximately 0.0838 peak at 48 kHz; Tape/Transformer group transitions produced approximately 0.00027/0.00057. These native probes are a failed acceptance checkpoint, not a reason to relax the silence criterion.

Round D follow-up: clear only `ironLP` when leaving Crisp and the shared `colorLP` when leaving the Tube/Tape/Transformer group. Preserve shared saturation interpolation, antiderivative and DC histories during active-model changes. The first stage checkpoint was insufficient and required this follow-up plus fresh post-change gates. Frontend static/unit evidence for unchanged source and any Go/build results at `d7146a2` remain tied to that earlier scope. The new paused-failure browser regression (`0fc952b`) first exited 1 against earlier packaged assets: Retry playback was not visible within five seconds. Its corrected packaged rerun exited 0 (one case, 3.4-second body / 9.6-second command). That bounded lifecycle pass did not close the model-history correction at that checkpoint.

### Iteration 2 — corrected integration checkpoint, 2026-10-22

Source `79a6b49` includes model-local history correction `2f7eab6`, stage-lifecycle correction `d7146a2`, paused-init cleanup `2883b5d`, packet guards `3740f84` and browser regression `0fc952b`. The Chair observed full Go module verification, vet, exact CI lint 2.15.0, identifier, vulnerability and race gates exiting 0 and empty formatting output. Nine compiled JS-target lifecycle/model tests passed, including 84 model-return cases. Rebuilt dual WASM modules, production binary and standalone empty-directory smoke passed. Constant-setting parity retained exact agreement across all 333 native/legacy/direct/restricted-WASI fixtures, maximum error 0. Nine dynamic actual-WASI model-history transitions at 8/48/192 kHz passed through numeric controls without reset between edits. A separate baseline/corrected native comparison generated 279+54 fixtures from the unchanged main-era engine and corrected integration; direct byte comparison matched the generated JSON contents for all 333 fixtures, establishing unchanged PCM for those constant-setting inputs.

Retained compiled failure: the added WASI regression first failed against the earlier reactor, Crisp at 8 kHz producing −0.0958729535. The rebuilt follow-up passed rather than relaxing the silence assertion. Independent QA and Devil’s Advocate reran their original probes successfully and found no new in-scope P0/P1 after `2f7eab6`.

Frontend TypeScript/lint/knip and 211 units in 17 files passed for the unchanged frontend correction. Configured spelling checked 126 files with zero issues, and all 11 agent definitions synchronized. Direct script spelling initially found six existing WASI import identifier terms; an explicit file directive and one-file rerun passed.

The current Newman rerun exited 0: 17 requests, 22 assertions and raw DNS-rebinding 403/upload-limit 413 probes passed. The complete Chromium suite exited 0: 54/54 in 3.0 minutes, including the new paused-init regression (1.8 seconds within this run), six-width axe checks, a 10.5-second large import and the 62-control PCM matrix in 30.5 seconds.

**Round E ruling:** QA and Devil’s Advocate independently accepted the stage/model-history, paused-initialization and packet-publication corrections with no new in-scope P0/P1 after the follow-up. Technical Writer confirmed all five documentation surfaces match the source and evidence. The bounded follow-up is locally verified; **open — awaiting merge**. New remote CI and owner merge remain pending. Constant-setting identity and these scoped lifecycle tests do not certify hardware fidelity, alias suppression, true-peak limiting or universally click-free automation.


## WASM DSP offline bridge safety and EQ prediction — 2026-10-22

Prior PR #4 was owner-merged at `ef18a7f`. Its documentation checkpoint `e237876` passed both recorded remote runs: [39720716299](https://github.com/yegamble/aurialis-WASM/actions/runs/39720716299), [39720713174](https://github.com/yegamble/aurialis-WASM/actions/runs/39720713174). Current work uses isolated branch `codex/wasm-dsp-bridge-safety`; previous wave records remain chronological evidence, not fresh acceptance.

### Round D — align the approximate EQ response prediction

DECISION: ACCEPT — P1 required correction.
WHY: The TypeScript prediction used RBJ math while the native engine uses TPT filters with shelf corner scaling and gain-dependent bell Q. Low shelf +6 dB at 250 Hz measured 5.898 versus displayed 3 dB, and at 500 Hz measured 2.413 versus displayed 0.376 dB; high shelf at 12 kHz measured 5.824 versus displayed 3 dB; a 1 kHz bell probed at 500 Hz measured 0.784 versus displayed 2.826 dB.
DISSENTING VIEW: Retain the existing approximate label. A prediction aligned with the native filter equations is not a certified hardware curve or a measured live device response.
AFFECTED LAYER: nextjs-ui, wasm-dsp.
USER / AUDIO IMPACT: Make the settings prediction describe the implemented filter response without changing the Go audio algorithm, styling or dependencies.
BUNDLE / TEST IMPACT: Existing TypeScript response math plus a compact independent native sine-response fixture; no added production dependency.
ACCEPTANCE CRITERIA: Prediction agrees with native response at fixture rates/frequencies, disabled/neutral bands remain correct, and requested/source-rate limits remain explicit.
TEST PLAN: Native sine oracle, frontend prediction cases, static/unit gates and browser response/editor regression coverage.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger as behavior warrants.

### Round D — preflight intrinsic typed-array metadata

DECISION: ACCEPT — P1 required correction.
WHY: A genuine one-element Float32Array with a spoofed own length of eight caused an oversized Uint8Array construction panic and Go runtime termination at the offline JS/WASM boundary.
DISSENTING VIEW: No ordinary GUI trigger or host-machine compromise was established. This is a malformed browser-library caller, not evidence of an upload or localhost-security bypass.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Use intrinsic branding and metadata for all input/destination checks before DSP state advances; reject unusable views while retaining a usable bridge.
BUNDLE / TEST IMPACT: Boundary preflight and actual compiled-WASM adversarial tests; preserve shared storage, nonzero offsets, output alias ordering and numeric zeros.
ACCEPTANCE CRITERIA: Shadowed properties cannot enlarge memory views, malformed inputs/destinations do not advance engine history, and subsequent valid blocks process normally.
TEST PLAN: Actual legacy WASM tests with genuine shadowed Float32Arrays, fake/detached/invalid views as applicable, shared/offset/alias/zero regressions and native/WASM parity.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

DEFER — P2: Native cross-output aliasing still has no demonstrated application caller. Do not add a generic alias framework or a broad exception catch after processing. Version 2/hardware-parity blueprints remain specifications only.

### EQ response failure and corrected prediction

EQ correction `39339d9` introduces 61 actual native sine configurations and 183 frequency probes across 8/44.1/48/96/192 kHz. The frontend fixture comparison allows less than 0.01 dB error for those cases. The engineer reported 64 EQ tests and 275 frontend units passing. The new browser regression failed against the earlier packaged response at 320 px: plotted 3.25 dB versus independent native 5.89847 dB, with a ±0.25 dB allowance for chart sampling and SVG rounding. The corrected packaged regression then passed at 320 and 1440 px in 551 ms within the fresh browser run; the original failed checkpoint remains retained. Independent Devil’s Advocate stress checks passed 24 configurations / 72 probes using ten-second native Float32 sine renders, Q 20 and gain ±24 dB at 8/48/192 kHz; maximum prediction error was 0.00000668 dB. An initial two-second high-Q probe differed by 0.06498 dB; extending settling resolved it without code or tolerance changes. The current Newman rerun passed 17 requests / 22 assertions plus raw curl probes.

### Round E — fresh integrated checkpoint

Source `3888681` includes EQ prediction `39339d9` and browser regression `554b6c7`. Native formatting, module verification, vet, exact CI lint 2.15.0, identifier, vulnerability and race gates passed; the identifier check used its `go run` fallback. Frontend TypeScript/lint/knip, configured spelling over 129 files and 275 units in 18 files passed. Bridge JS-target vet and exact CI lint passed; direct spelling checked the changed Go/MJS bridge files with zero issues. The fresh integrated binary build rebuilt both WASM modules, the frontend and Go executable; empty-directory smoke passed.

Fresh compiled verification passed 279+54 legacy/native fixtures with maximum error 0 plus shadowed-metadata, malformed-view rejection/history and subsequent-valid-processing checks. Direct and restricted-WASI parity each matched all 333 fixtures exactly, and nine retained model-history transitions passed. The rebuilt-assets native API rerun passed 17 requests / 22 assertions plus raw curl probes. QA independently passed 48 fresh compiled-module boundary cases, including eight invalid-view families across all four channel positions, throwing own metadata and a resized ArrayBuffer. Rejected calls preserved destinations and active Crisp/compressor history; the next valid block exactly matched its control. The original own-length-eight probe processed its actual one stored frame and the runtime remained usable. QA and Devil’s Advocate found no new in-scope P0/P1 in the corrected source. The complete Chromium suite exited 0: 55/55 in 3.4 minutes, including the new EQ plot regression at 320/1440 px in 551 ms, all six-width axe checks, the 62-control export PCM matrix in 32.7 seconds and a 13.1-second large import.

**Round E ruling:** QA and Devil’s Advocate independently accepted the corrected prediction and offline bridge with no new in-scope P0/P1. Product Engineer accepted the bounded scope and atomic commit history; Technical Writer confirmed the five documentation surfaces match the implementation and evidence. The follow-up is locally verified; **open — awaiting merge**. New remote CI and owner merge remain pending. The approximate prediction is not a certified device/hardware response, and malformed library-call resilience is not evidence of an ordinary GUI failure or host-machine compromise.


## CI FFmpeg provisioning repair — 2026-10-22

The user authorized repairing the failed PR #5 CI gate. Both [run 39790348108](https://github.com/yegamble/aurialis-WASM/actions/runs/39790348108) and [run 39790323228](https://github.com/yegamble/aurialis-WASM/actions/runs/39790323228) timed out during FFmpeg installation after more than 18 minutes. Logs listed 100 new packages, including a 27.4 MB recommended speech-language package and graphics drivers. Go/static, race and parity steps and the frontend job passed; the independent meter comparison did not execute.

Workflow correction `72839a1` reuses an installed FFmpeg or provisions it with `--no-install-recommends`, two acquisition retries and 30-second HTTP/HTTPS timeouts. Logs also showed slow core-package downloads from the Azure archive; only when installation is needed and `/etc/apt/apt-mirrors.txt` exists, the workflow replaces that URL with Ubuntu’s official HTTPS archive. Package signature validation remains enabled. Separate five-minute provisioning and three-minute comparison step limits retain the independent meter assertions and existing job timeout. No production code or API contract changes.

Local actionlint 1.7.7 passed. All 15 actual FFmpeg comparisons passed, with maximum reported differences of 0.0542 LU and 0.0312 dB; the whitespace check was clean. New remote evidence remains pending. Status: **open — awaiting merge**, with CI verification still required. Preserve the failed provisioning checkpoints; successful local application gates do not replace the missing remote meter comparison.

### Concurrent reader-guide integration

Main advanced through reader-guide PR #10 at `bbc254a` while Simple PR #11 was being published. The Simple branch merges that documentation-only update and preserves the readable README, first-use and developer guides, with current Simple styles and the device-local hosting decision added. Runtime source remains identical to the 82-case passing `adf0032` checkpoint; exact merged-head CI remains required. The earlier README claim review is historical and does not verify the newer Simple controls.


## Device-local browser jobs and static hosting — 2026-10-23

**Round D ruling:** implement the user’s explicit all-audio-local deployment decision with the common Go CDR/mastering/compiler in disposable browser Workers. Public/non-loopback origins always use browser processing; the browser target forces that mode even on loopback preview. The native executable’s own loopback UI is the explicit local fallback. Hosted Go Containers, gateway sessions and R2 audio uploads are superseded and remain outside the merge. Old production resources stay unchanged until reviewed preview/canonical acceptance and fresh inventory permit safe retirement.

The closed worker ABI separates bounded metadata from transferable binary audio and retains source receipts, source-bound ScriptV2 rendering, compiler `sourceVerified: false`, DTO checks and latest source/revision ownership. One costly worker plus one waiting job, conservative memory preflight, deadlines and terminate-on-cancel/completion bound processing. The static Worker permits GET/HEAD only, preserves exact inline-byte CSP/isolation/WASM MIME, rejects audio APIs and unknown files, and serves known dynamic HTML/RSC shells. Constant-name modules retain no-store/revalidation and incompatible ABI initialization fails before processing. Exact bundled font/runtime notices are retained; no trained model assets are published.

**Latest local qualification — source `cd0e404`, base merged Release `01c2c15`:** fresh separate native/browser builds and exact target receipts passed complete member removal/restoration; the static proof additionally removed the full generated asset tree. Frontend strict typing/configured lint/Knip/spelling and **434/434 units** passed. This includes 12 transport cases, 26 Release/core/download cases and four Album ownership/error cases. Worker/E2E/generated types and strict harness lint passed. Go formatting/module/vet/pinned 2.15.0 lint/identifier/vulnerability/race/JS-target gates passed at `dbafc3b`; Go source/configuration is unchanged through `cd0e404`. The extracted pure mapper is byte-identical, remains re-exported and is consumed directly by the Node verifier.

Native production/QA restoration passed empty-directory smoke, 333 exact audio fixtures, nine history transitions, 45 actual automation fixtures, 15 independent FFmpeg comparisons, Newman 34 requests/39 assertions and raw security probes. The full **107/107** native-loopback browser suite passed in **6.1 minutes**, without skipped, unexpected or flaky outcomes. The restored static build has 92 assets and 35 exact CSP hashes; **8/8** actual browser cases passed in **25.8 seconds**. Four saved inventories contain **233 same-origin GET/HEAD requests with zero bodies**. All five final encoded reviews and repeated 16/24/32-bit retained Release downloads matched native WAV bytes, hashes and layout; maximum measured diagnostic error was 4.80e-14. Revision 4’s +3 dB Deep move yielded 16,384 exact captured live frames and a native-identical 1,152,044-byte WAV. Thirteen native/actual Go-WASM job oracles passed, with maximum whitelisted diagnostic error 1.1368683772161603e-13; controls, source, compiler packets, clocks and audio bytes remain exact. Ten native plus ten browser artifact-boundary cases and official actionlint 1.7.7 passed.

The ignored exact-source index is `artifacts/browser-local/final-browser-cd0e404/proof-manifest.json`; raw logs, requests, encoded artifacts and both packages are retained. Documentation commits do not relabel those local artifacts. Root accepted the ownership, confined-fixture and unchanged-mapper seams. Independent final scoped QA/Devil’s Advocate review accepted `cd0e404`, separately checking the exact source, artifact hashes, encoded metrics and body-free request inventories.

**Retained earlier checkpoints:** the following observations preserve their original source and pending status; the latest qualification above supersedes only their local follow-up gates.

**Bounded local evidence:** rebased onto merged Deep `6154f87`; fresh browser-target build, exact native/static CSP and 7/7 actual static Worker browser cases passed in 17.4 seconds, with zero skipped/flaky cases. Import/export, hostile CDR, stale-module fresh retry, routing, measured Reference, album/release and Deep analyze/edit/compile/apply/export were exercised. One authored +3 dB move produced 16,384 actual live frames with maximum native error 0 and an exact 1,152,044-byte source-bound WAV. Standalone request inventories contain only same-origin GET/HEAD and zero bodies. Original six-case/13-oracle artifacts are preserved before integration; the list-reporter attachment-retention gap was corrected with saved JSON evidence and a fresh seven-case pass.

The 13 native/actual Go-WASM oracles also passed: audio/source/control/geometry/compiler packets remain exact. Finite whitelisted diagnostic/scoring fields use only the fixed absolute 1e-10 bound, with maximum observed error 1.1368683772161603e-13. Preserve the original whole-JSON mismatch and its 3.55e-15/1.7e-17 diagnostic deltas; this is no general tolerance for controls or arbitrary inputs.

**Source follow-up:** rebased onto merged Release `01c2c15`, preserving the original proof branch. `193bdac` adds a closed three-member browser artifact profile without relaxing native five-file defaults; `c22bb53` adds one distinct browser producer, receipt-verified static consumer and existing protected-aggregate dependencies. Nine native and ten browser artifact units, official checksum-verified actionlint 1.7.7 and invalid/missing-receipt launch guards passed. Owned resident scopes (`dafec45`/`cc8f15c`/`a5a3f06`) add exact retained bytes and protect active allocation between preflight and cloning; ten focused transport units and strict TS/lint passed. The first test-only lint failure required four void-arrow block bodies; it remains retained. Existing album owner `8a3dc7c` passed three lifecycle cases (prefix failure, order invalidation, late completion after unmount) plus ten transport cases and strict TS/lint/spelling. The first test typecheck rejected five Playwright-style options unsupported by Testing Library; their removal changed no assertion. Actual new build/restore and Release owner integration are not yet qualified. Shared download ownership subsequently passed three new URL lifecycle cases plus four album-owner/error cases, strict TS and targeted ESLint. It reserves before URL creation, retains through revocation, shares simultaneous same-Blob ownership and surfaces album allocation/click errors. Temporary download and UI-cache owners deliberately overlap conservatively. Preserve the first stale test-spy expectation and later unbound-method lint failure; only test bindings changed before the same assertions passed. No fresh static or deployment acceptance follows. Release ownership now claims expected source bytes before IDB, full hash/inspection copies before allocation and exact retained output through replacement/disposal. Its focused 25/25 controller/core/download cases, strict TS/targeted ESLint/actionlint passed. Binding-hash settlement is awaited in controller tests; the historical act warning remains retained. An initial exhaustive-type lint guard was changed to equivalent encoding membership after 23/23 assertions passed. Independent review required retaining the original source after render: source-plus-output persists through final verification, with source-plus-three-encoded-buffer inspection admission. A real budget boundary rejects before the encoded read. The corrected focused set passed 26/26 plus strict TS/targeted ESLint; JSON downloads also reuse the shared helper without DTO changes. Actual integrated static Release/build/restore acceptance remains open. Pinned 2.15 Go lint additionally rejected six opt-in test fixture paths; confine those fixed names with `os.OpenRoot` rather than suppressing taint checks, without adding production audio I/O. Retain the failed checkpoint before fresh lint/oracle/race execution. Fresh native build/actual five-member restore/smoke and 333 exact fixtures plus nine history transitions passed, but Node direct-TS resolution then stopped automation before API/browser execution. Extract the verbatim pure parameter mapper and re-export it for existing clients; import that same module directly in the verifier, without loaders or altered fixtures. Retain the original error before fresh qualification. The initial full frontend gate passed TS/lint then exposed dead `measureScriptAudio` in Knip. Remove that unused wrapper until Album supplies its planned real caller; add no exemption or runtime task. Source follow-up needs fresh qualification and does not relabel the existing `a669729` proof. The static consumer now uses the same merged bounded Ubuntu helper and separate OS/binary deadlines, with actionlint passing; fresh Linux execution remains open. A later resource review closed uncharged waiting Blobs: synchronous raw-input ownership now precedes enqueueing and outlives early caller cancellation until underlying settlement. Twelve focused transport cases passed (634 ms), with strict TS/lint, covering low-memory pre-clone rejection and canceled-waiter retention/release. Active input is conservatively charged in both this owner and the existing preflight estimate. Queue/concurrency/audio contracts did not change.

**Round E status: locally verified; open — awaiting merge.** Final scoped QA/Devil’s Advocate/writer/Product review accepted the bounded local slice. Exact final-head remote CI remains required before delegated merge. Public preview and both domain migrations also require separate acceptance of explicit local legacy-library recovery: selected supported WAVs pass through existing CDR, old metadata/settings are never executed, and every old record plus unsupported compressed original remains stored. The new app must not re-export raw originals. Separately qualified clean PCM recovery is required before permanently retiring rollback resources; recovery must not automatically migrate or delete records. No preview or production domain has been switched and no old resource deleted. Local finite evidence does not close trained separation, studio/hardware/Waves equivalence or arbitrary host deadlines.

| `TP-1` | P1 | wasm-dsp | Opt-in lookahead true-peak limiter as algorithm 2 (v1 frozen; offline renders latency-compensated) | merged (PR #20). Supersedes the MUB-2B reservation of ID 2 for the studio bundle, which moves to the next free ID. |
| `TP-2` | P1 | frontend / wasm-dsp | Browser exports (download, album, release check) render with algorithm 2 and `limiter.truePeak`; previews and live stay on algorithm 1 | merged (PR #22, 2026-10-24); locally verified (`unit`). |
| `CF-1` | P1 | ci-cd | Main deploys the verified browser artifact to Cloudflare production; Workers Builds creates branch Worker Previews; rollback dispatch | merged (PR #29, 2026-10-26); locally verified (dry-run + live-domain smoke). Workers Builds dashboard setup is owner-pending. |
