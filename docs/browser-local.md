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

## Shared contracts

`internal/browserjobs` exposes a closed metadata contract for render, source features, Deep analysis, measured Reference and numeric automation compilation. It calls the existing native Go container validator and DSP/mastering implementations. Source identities hash the reconstructed PCM with the same Go layout. Script rendering independently checks the actual source digest. Compilation alone continues to report `sourceVerified: false`.

Each browser job has a 130-second client deadline. JSON metadata is limited to 2 MiB plus 128 KiB; source audio travels separately. The local native API retains its existing execution and reservation limits.

## Static hosting

The static Worker serves only GET and HEAD requests. It preserves the native CSP's exact generated inline-script hashes, COOP/COEP/CORP isolation, fixed WebAssembly MIME type and other security headers. Missing APIs and unknown files return errors rather than an HTML app shell. Dynamic workspace HTML and App Router text files resolve through known generated placeholder assets.

Cloudflare's current individual static-file limit is 25 MiB. Any qualified public model package must use immutable, hash-verified shards no larger than 16 MiB. Model distribution is separate from user audio; no R2 upload bucket or remote audio Container is required. The large trained model and an efficient browser inference kernel remain separate acceptance work.

## Verification status

The first bounded native-service tests passed, including exact native HTTP/render PCM equality, source identity, hostile CDR, measured Reference and source-bound compilation/rendering. Seven transport units passed, covering cancellation, memory rejection, stale identities, no audio fetch and loopback-only native mode. The fresh static build, strict Worker typing and exact static/native CSP comparison passed. The latest four actual Cloudflare-local Worker browser cases passed in 6.1 seconds: exact native 32-bit float export, hostile CDR, a reproducibly compiled incompatible real Go module rejection/fresh-worker retry and HTML/RSC/security routing. Audio workflow browser contexts made zero POST, DELETE or request-body transfers. Thirteen bounded native/Go-WASM oracle checks passed with exact WAV/dither bytes, source identity, render controls, integer geometry and numeric compiler packets. Whitelisted floating diagnostic/scoring fields differed by at most 1.1368683772161603e-13 against a fixed absolute 1e-10 limit. The original whole-JSON equality failure is retained: LUFS differed by 3.55e-15 dB and low-bass correlation by 1.7e-17. No tolerance applies to controls or compiled schedules. These observations cover finite fixtures; complete integrated feature, platform, review and CI acceptance remain required before merge or switching the public deployment. The existing public deployment is unchanged.

## Bundled notices

The app includes unchanged license notices for its installed Instrument Sans and Newsreader fonts, React, React DOM, Next.js, Tailwind CSS and Go runtime. They are available under `/licenses/`; `provenance.json` records exact installed versions and notice digests. Both native and browser build scripts refresh these notices from their actual installed sources. These third-party notices do not assign a license to Aurialis-WASM itself. Qualified model or GPU-kernel redistribution requires its own exact upstream notices before publication.
