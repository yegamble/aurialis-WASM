# Processing audio on your device

The browser build keeps imported audio, measurements and mastered files on your device. Cloudflare serves the application and audio-engine files. It accepts no audio uploads.

This browser execution path is under verification on `codex/browser-local-jobs`. It has not replaced the existing public deployment yet. The local native executable remains available for jobs that exceed a browser's resources.

## Where processing happens

| Work | Browser build | Local executable |
| --- | --- | --- |
| Validate and reconstruct a WAV | Shared Go CDR in a dedicated Web Worker | Same Go CDR through the executable's loopback API |
| Analyze, match a reference or render/export | Shared Go mastering code compiled to WebAssembly | Same Go mastering code compiled for the device |
| Play the current settings | Shared Go/WASI DSP in AudioWorklet | Same browser AudioWorklet path |
| Store projects and source audio | This browser's localStorage and IndexedDB | This browser's storage at the local app's address |
| Trained instrument separation | Unavailable until browser inference is measured and qualified | Separate native-model qualification remains open |

A public website always chooses browser processing. It never switches to a remote audio API or probes for a local server. To use native processing, open the local `aurialis` executable and its own loopback studio. Moving between origins does not move browser storage; keep original files and project backups.

## Job and memory limits

One expensive browser job runs at a time, with at most one waiting job. Cancel terminates the active worker. Completion, failure and cancellation release its private Go heap. Existing source and project ownership checks still prevent late results from replacing a newer selection.

Binary input and output use transferable buffers, never audio encoded as JSON or base64. The shared binary-input limit is 129 MiB, including both Reference sources. The existing decoded-frame and format limits remain in effect.

Before allocating a worker, the client estimates simultaneous original/canonical files, live PCM and AudioBuffer, transferred input, Go raw/decoded/render/encoding data and returned buffer/Blob. It reserves another 64 MiB for runtime overhead. The estimated budget is 256 MiB on devices reporting at most 2 GB memory, 1 GiB on devices reporting at least 8 GB, and 512 MiB otherwise. These are conservative admission estimates, not promises about browser memory availability. A browser may still stop a job; use the local native app when that happens. Aurialis does not silently shorten, resample or upload a rejected file.

Callers retaining album outputs, intermediate masters or reviewed WAVs must register their exact resident bytes through `reserveBrowserAudioMemory`. Each owner updates its own count and disposes it on discard/cancel/unmount. Counts sum with the active job estimate; malformed/unsafe/over-budget changes reject synchronously. The job keeps its allocation charged through cloning and processing, including progress callbacks. The existing album cache registers its cumulative output before rendering and keeps that owner until invalidation/replacement/unmount; late completion after disposal cannot retain it. Three focused lifecycle tests passed. Local WAV downloads use a shared temporary owner through the one-second object-URL lifetime, so view disposal cannot leave a live URL uncharged. Same-Blob URLs share that temporary owner, which conservatively overlaps a retained cache. Creation/click failure cleanup and delayed final release passed three focused cases. Wiring the final Release owner remains an integration gate.

## Shared contracts

`internal/browserjobs` exposes a closed metadata contract for render, source features, Deep analysis, measured Reference and numeric automation compilation. It calls the existing native Go container validator and DSP/mastering implementations. Source identities hash the reconstructed PCM with the same Go layout. Script rendering independently checks the actual source digest. Compilation alone continues to report `sourceVerified: false`.

Each browser job has a 130-second client deadline. JSON metadata is limited to 2 MiB plus 128 KiB; source audio travels separately. The local native API retains its existing execution and reservation limits.

## Static hosting

The static Worker serves only GET and HEAD requests. It preserves the native CSP's exact generated inline-script hashes, COOP/COEP/CORP isolation, fixed WebAssembly MIME type and other security headers. Missing APIs and unknown files return errors rather than an HTML app shell. Dynamic workspace HTML and App Router text files resolve through known generated placeholder assets.

Cloudflare's current individual static-file limit is 25 MiB. Any qualified public model package must use immutable, hash-verified shards no larger than 16 MiB. Model distribution is separate from user audio; no R2 upload bucket or remote audio Container is required. The large trained model and an efficient browser inference kernel remain separate acceptance work.

## Verification status

The seven-case audio proof was recorded at `4e5b40b`, based on merged Deep `6154f87`. The current branch is rebased onto merged CI main `d75f56a`; new artifact and memory-owner changes have focused checks only until a fresh integrated build/run. These observations cover finite fixtures; full integrated CI, independent review and merge remain required before publishing the replacement.

- **Native/service and transport:** shared CDR/render/source-identity checks passed; the latest ten bounded transport units include summed owners and pre-clone growth rejection. Strict typing, Worker type generation, lint and exact native/static CSP comparison passed.
- **Actual static browser:** seven cases passed in 17.4 seconds, with zero skipped/flaky. They cover exact native import/export, hostile CDR, incompatible-module retry, HTML/RSC/security routing, measured Reference, album/release and Deep analysis/edit/compile/apply/export. A +3 dB move compiled locally; 16,384 captured 48 kHz live frames had maximum native error 0. Its complete 1,152,044-byte WAV was byte-identical to native.
- **Network evidence:** standalone JSON inventories retain all observed browser/worker requests for Reference, album/release and Deep. They contain only same-origin GET/HEAD and zero bodies. The list reporter originally kept inline attachments only in memory; saved files and a fresh seven-case rerun corrected retention. The app runtime was unchanged.
- **Native/WASM oracle:** thirteen bounded checks passed with exact WAV/dither bytes, source identity, controls, integer geometry and numeric compiler packets. Only whitelisted finite diagnostic/scoring fields permit a fixed absolute 1e-10 difference; the maximum was 1.1368683772161603e-13. The original whole-JSON failure is retained: LUFS differed by 3.55e-15 dB and low-bass correlation by 1.7e-17. No control or schedule tolerance applies.

The public deployment remains unchanged. Trained browser separation, actual browser-target artifact restoration, Release integration and reviewed preview/domain migration are still open. These checks do not establish arbitrary music, device or deadline acceptance.

## Browser build artifacts

CI builds native and browser targets separately and once per target. The browser artifact has three fixed members containing the asset tar, exact asset manifest and generated policy. Each asset has a size, mode and SHA-256; its path must match the policy exactly. Restore checks source/head/run/producer-attempt/platform/target facts, rejects links/traversal/duplicates and enforces bounded files and metadata. A native artifact cannot stand in for browser assets. The static runner verifies its receipt again before launch and contributes to the existing protected browser gate.

The new profile passed ten tiny adversarial cases; all nine native artifact cases still pass. Official actionlint 1.7.7 and invalid/missing-receipt launcher probes passed. These source checks do not replace an actual fresh build, complete restore, browser run or remote CI.

## Bundled notices

The app includes unchanged license notices for its installed Instrument Sans and Newsreader fonts, React, React DOM, Next.js, Tailwind CSS and Go runtime. They are available under `/licenses/`; `provenance.json` records exact installed versions and notice digests. Both native and browser build scripts refresh these notices from their actual installed sources. These third-party notices do not assign a license to Aurialis-WASM itself. Qualified model or GPU-kernel redistribution requires its own exact upstream notices before publication.
