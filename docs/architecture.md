# Aurialis-WASM architecture
<!-- cspell:words Hann steganography -->

This describes current implementation boundaries. [`AGENTS.md`](../AGENTS.md) and [`docs/tasks.md`](tasks.md) retain the full product requirements. Implementation on a branch is not verified delivery or a merge to main.

## Build and serving

`pnpm run build:binary` runs `scripts/build.sh`: compile `wasm/dsp` for `js/wasm`, copy the matching Go `wasm_exec.js`, run the Next.js static export and `scripts/sync-webui.mjs`, then compile `cmd/aurialis`. `internal/webui` embeds generated assets with `//go:embed all:embedded`. The native executable serves HTTP APIs and the frontend without Node at runtime.

`pnpm run test:binary` runs the executable from an empty directory, preventing source-tree assets from masking missing embedded files. The host serves embedded assets only; source-tree output cannot replace the embedded application. Generated assets are not committed, so a fresh `build:binary` is required for a usable application. Dynamic route IDs resolve to static exported shells and browser state supplies the project.

The default bind address is `127.0.0.1:8080`. The middleware emits COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, CSP, nosniff and frame denial headers. Host/Origin and Fetch Metadata checks protect localhost; these checks are not a remote multi-user authentication system.

## Actual browser audio path

1. Home accepts WAV files up to 16 MiB. Import posts source bytes with bypass enabled to `/api/master/render`, validating and reconstructing canonical 32-bit float WAV using Go.
2. The canonical source Blob is stored in IndexedDB. Project metadata/settings use localStorage; storage failures display a warning and preserve an in-memory source for the session. Missing source audio blocks rendering/export and requires upload again.
3. Advanced settings are independent state fields. **Render preview** loads the real Go WASM module and invokes `aurialisDSPInit`, `aurialisDSPSetParams`, `aurialisDSPReset` and `aurialisDSPProcessBlock` over the decoded source. It processes complete buffers before playback, serializes WASM preview work and yields during long renders; navigation cancels the pending preview. MasterView is keyed by resolved track ID, ensuring track changes remount it and invoke render-abort cleanup. A selects original source and B selects the processed buffer; editing settings invalidates B.
4. Export posts the actual source and latest parameters to the native Go render API. It preserves sample rate and frame count and returns 16/24-bit PCM or 32-bit float WAV. The shared pure-Go engine is `internal/audio/dsp`; frontend code converts parameters and encodes/decodes browser audio rather than maintaining an alternate DSP chain.

The transport supports play/pause, seek and volume. Loudness-matched A/B and continuous real-time DSP are outstanding. The production preview does not implement an AudioWorklet/SharedArrayBuffer streaming bridge. The packaged browser runtime is `/wasm/wasm_exec.js`; isolation headers alone do not prove real-time integration.

## DSP and measurement boundaries

The Go engine implements gain, five EQ bands, compressor, saturation, stereo processing and limiting. Compressor topology names currently share the same mathematics; the saturation characters are heuristic models. Mono-bass uses side-channel filtering that preserves the mono mid signal; it is not a validated textbook Linkwitz–Riley crossover. Current mathematical and safety tests establish particular transfer behaviors; they do not certify named hardware emulations, a Waves-equivalent chain, formal ITU/EBU conformance, or anti-aliasing performance. Limiter safety remains a sample-domain boundary; its streaming cubic interpolation is separate from the offline peak meter.

Browser metrics are measured sample peak in dBFS, RMS and crest factor. The API meter uses independent BS.1770/DeMan K-weighting, 400 ms windows at 75% overlap, an absolute −70 LUFS gate followed by a relative −10 LU gate, and a trailing three-second short-term interval. Shorter clips use their available duration for diagnostic reporting. The offline peak estimate uses a 49-tap, 4× Hann-windowed sinc interpolator with end padding. Fifteen external FFmpeg comparisons at 44.1/48/96 kHz reported at most 0.0542 LU loudness error and 0.0312 dB peak error for the selected fixtures; abrupt 8 kHz boundaries can differ by 0.58 dB. These are bounded fixture comparisons, not all-waveform guarantees or formal standards certification; the limiter has no validated true-peak/lookahead guarantee. `targetLufs` remains metadata and does not normalize the audio; rendering no longer performs implicit target gain calibration. See [`api.md`](api.md) for field limits. `pnpm run test:wasm` runs real compiled WASM/native parity fixtures; `pnpm run test:meters` runs independent FFmpeg meter comparisons. Both are wired into CI.

## Jobs, uploads and lifetime

`internal/server` handles bounded multipart requests and decodes audio in memory. User-supplied filenames do not become disk paths. Decoders accept mono/stereo PCM/float WAV and 16-bit PCM AIFF, rejecting multichannel input. AIFC and compressed formats are rejected; recognized compressed signatures are not evidence of decoders. Reconstruction emits new WAV samples and discards metadata. Signature checks inspect headers/metadata/trailers, never arbitrary PCM bytes; this is not steganography detection. Finite float-WAV headroom survives decode/export, while non-finite values are sanitized and integer exports clamp to full scale.

`internal/jobs` owns the experimental Deep-analysis and heuristic separation queues and cancellation. These APIs are not connected to enabled product workflows. Multipart bodies have a hard 32 MiB cap and decoding is capped at 4,194,304 output frames. Two concurrent upload/render requests are admitted; the third receives 429. Job input plus reserved/retained WAV memory is bounded at 256 MiB, retention at 64 records, and worker count at four. This reservation is not a total RSS cap; temporary DSP scratch is separately bounded by frame and worker limits. Jobs time out after two minutes; terminal artifacts expire after 15 minutes. See [`api.md`](api.md).

## UI and remaining product scope

Next.js 16 App Router, React 19, strict TypeScript and Tailwind v4 provide the warm editorial design. Production icons are custom inline SVGs. Shared controls and the shell support mobile and desktop layouts; automated axe and overflow checks are evidence for tested routes and interactions, not blanket WCAG certification.

Simple/Deep processing, Smart Split, album consistency, Reference Match and Release Check expose unavailable states instead of simulated outcomes. Legacy implementations remain in source for follow-up work but are not rendered as usable workflows. The full 2–6 stem, MasteringScript v1, AI repair, album, reference and release requirements remain open in [`tasks.md`](tasks.md).
