<!-- cspell:words ALAC downmix gapless kbps Vorbis -->

# Private decoder comparison evidence

The private native decoder and actual browser Worker passed 23 generated positive cases. One requested mono HE-AAC case remains uncovered. This is finite decoder comparison evidence, not approval to activate compressed recovery or distribute the compiled libraries.

No application imports these experiments. The comparison did not call Go CDR, save a project, inspect an old browser library or publish a recovery result. All signals were generated for these tests. Earlier failures and their original outputs remain retained.

## Frozen selection and runners

The canonical matrix is `/private/tmp/aurialis-private-decoder-comparison-fixtures-01/matrix.json`, SHA-256 `9e3fd822baf0b42cde54250a28a24f3a2c05d6999623376550e9362a5945c91b`. It freezes all 24 candidate IDs, input hashes, independent lossless references, expected profiles and geometry, and ten exact runner sources. The `comparison/` sources are byte copies of that frozen recipe.

The matrix selects stereo FLAC at 96 kHz, preserving the earlier 48 kHz candidate. Mono FLAC includes 8, 22.05, 48, 88.2 and 192 kHz. The 88.2 kHz candidate contains actual 32-bit coded samples, nonzero low bits, integer extremes and Float32 rounding boundaries. Its expected samples derive directly from signed integers divided by 2^31, then rounded to binary32. Earlier FFmpeg-generated 24-bit output for that candidate remains a recorded missing-coverage result.

The immutable native oracle is 1,568,984 bytes, SHA-256 `6e46840d28c656aa6b6957d1c75f995751bd28538558e426bf63e8859f5cda87`. It uses the same pristine FFmpeg 9.0.1 commit as the WASM core, with independently authored packet collection and native-channel sample conversion. The `native/` source snapshot was frozen before the successful second native link. The first native compile failure remains recorded separately.

The runtime remains relink05: WASM SHA-256 `261c4b4b5cb9ad36e7ac5eebc3dccfc9a0f319b15d2cff53acac263ec4530878`, fixed 64 MiB imported memory, and Worker SHA-256 `9e8090873b1af9d69bfa9ed356a7edfc4d8f675e15fff2bdf8da9c9fd4ef8c1d`. No C or FFmpeg rebuild occurred during comparison. Historical pending fields in its immutable package manifest are superseded only by the separately hashed inspection and execution receipts.

## Observed results

Native result SHA-256: `bb970fe720d04e585045bcfa76776ba22f8b27d91a6cf62561ad7f2e69f57a76`. Browser result SHA-256: `84e790e28631008d85aef79bd277de9cd57aafd275976085e783d06245daae0d`. `evidence.json` records artifact paths, hashes and limits. The original native PCM, frame traces, browser PCM, complete request inventory and process receipts remain in the private output directories.

| Cases | Actual evidence |
| --- | --- |
| MP3 mono/stereo and intentionally shorter raw MP3 | Native and WASM PCM bit-exact; untagged mono retains 46,080 frames, gapless stereo retains 44,149. |
| FLAC and ALAC | Native and WASM PCM bit-exact against independently rounded source samples, including actual 32-bit FLAC. |
| Vorbis and Opus mono/stereo | Native and WASM PCM bit-exact; 48,049 decoded frames. Opus output is 48 kHz. |
| AAC-LC, stereo HE/HEv2, M4A and edit-list cases | Exact native/WASM frame, rate and channel agreement. Positive maximum absolute error was 5.960464477539063e-8; maximum RMS was 4.3283845294915466e-9. |
| Requested mono HE-AAC | Actual first native frame reports HEv2, stereo, 48 kHz. This remains diagnostic and uncovered. A permitted 96 kbps encoder alternative produced byte-identical output to the earlier 64 kbps candidate. |

The limits were set before decoding: maximum absolute lossy error 2e-5 and RMS error 2e-6; lossless comparisons are bit-exact. Mono duplication must be bit-exact between the two WASM channels. No alignment shift, duration trim, padding removal, application resampling, downmix or normalization was applied. Raw ADTS and MP4 counts follow actual decoded frames and skip/discard behavior; they are not forced to the pre-encode source duration.

The actual browser inventory contains 168 GET requests, all to the private local asset server, with no blocked request or page error. Audio entered through a selected generated File, never HTTP. The server served only fixed assets and rejected non-GET/HEAD methods; the fresh contexts blocked other methods and origins before navigation. The strict CSP allowed self-hosted scripts and WASM compilation, without general unsafe-eval.

The native process used the exact pinned offline image with 2 CPUs, 4 GiB memory and no extra swap, 256 PIDs, a read-only root, no network and dropped capabilities. Each native case had a 30-second watchdog. The browser supervisor had a 15-minute suite deadline, a 4 GiB sampled Node process-group RSS monitor and a 130-second Worker deadline per case. Playwright launches detached Chromium in a separate group, so the recorded 247,119,872-byte sample does not cover aggregate browser RSS. Normal browser/context close passed; cleanup after a Node crash remains unproved. The next runner must record the public BrowserServer process identity and monitor/clean both owned groups before malicious-input testing. The browser monitor is not a kernel memory quota. Native and browser receipts report no timeout, resource failure or cleanup error.

The total 512 MiB comparison budget included all five original fixture directories, staged inputs and references, native and browser output partitions, assets and supervisor logs. Actual retained comparison material was 36,261,945 bytes at inspection. Earlier build caches remain subject to their separate recorded build limits. The later identical encoder alternative is additional retained test provenance, not hidden in that historical total.

## Synthetic checks and retained failures

Six Node 26 collector/comparator cases passed. They include an old queued end arriving after cancellation and a new operation, prefix-then-error disposal, geometry changes, exact mono duplication, lossless differences and fixed lossy tolerances. Five Python native-runner cases passed, including first-frame authority, codec-ID mismatch, changed geometry, closed reference paths and owned-child cleanup after a synthetic monitor exception. A separate synthetic generator monitor-exception test passed. These tests do not run a compressed parser.

Generation attempt04 lost its monitor because the sandbox denied ps. Its historical child PID and exit status were not captured. A later narrow process observation found no current encoder with the exact owned output argument; no unrelated process was signaled. The RED, generated bytes and this distinction remain retained. The generator supervisor now kills and reaps its owned process group in finally, preserving primary and cleanup errors separately. The original generator source was reconstructed from the controlled cleanup diff and matched its previously recorded SHA-256 exactly; this is not represented as a snapshot captured before generation.

## Remaining gates

Hostile trailers, malformed containers, actual quota boundaries and busy-C cancellation remain unqualified. In particular, raw MP3/ADTS/FLAC envelope preflight currently has no explicit hostile-trailer check. Successful positive decoding does not establish payload rejection. Future malformed failures must retain the original, discard all PCM prefixes, produce no successful end and never reach CDR or publication.

Actual Go CDR, clean PCM identity, fresh defaults, durable save, second old-source verification, cancellation through settlement and staged rollback require a separate integration gate. Source, license, notice, replacement/relink and clean-build reproducibility reviews also remain open. A separately initialized Worker does not settle LGPL obligations. No universal codec support, Waves equivalence, public deployment or project completion follows from these private results.
