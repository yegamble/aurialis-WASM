# Private compressed-source recovery experiment

Status: private source with synthetic unit evidence only. No compiled decoder, browser, measured resource or licensing qualification has run. Nothing here is imported by the application, copied into public assets or deployed.

This experiment prepares one on-device decoder step before existing Go CDR. It does not deliver compressed recovery, establish every codec the old Web Audio implementation accepted, or permit permanent retirement of rollback resources.

## Exact inputs and build

`sources.lock.json` pins official FFmpeg n9.0.1 tag object, commit and Git source tree, plus the official Emscripten 6.0.13 linux/amd64 image manifest digest. GitHub reported the release tag signature valid. Docker Hub's multi-platform index digest is recorded separately. The exact FFmpeg Git commit and signed tag object have now been fetched into a private setup directory and verified pristine with the pinned source tree and strict Git fsck. No source archive has been downloaded. The exact pinned image is now present locally after a single 57.237-second pull. Its manifest/configuration hashes, platform, runtime configuration and four RootFS diffIDs match the pinned official metadata. Actual compressed content is 859,519,629 bytes, unpacked data is 2,624,479,232 bytes and total Docker storage accounting is 3,483,998,861 bytes. This setup evidence is separate from a successful build.

An archive SHA-256 is deliberately null: inspected official metadata did not supply one. Do not invent or accept an unverified archive digest. The recipe accepts only a pristine Git checkout at the pinned commit/tree; a later approved setup must preserve its verified corresponding source and record any archive independently.

The original post-pull checks failed because they expected a configuration digest in Docker 29 containerd's manifest-ID field and compared total content-plus-unpacked size with an unpacked allowance. Both RED checks remain in the private setup evidence. The matching engine source at commit 3ce5872 confirms target/manifest-ID semantics; the read-only Engine API separately provides compressed and unpacked sizes. No compiler or runtime budget was widened to conceal those checks.

The corrected future acquisition preflight uses an explicit 4 GiB maximum for unpacked image data plus the exact 859,519,629-byte compressed content, a 512 MiB source allowance, 2 GiB output and 6 GiB untouched disk reserve: 14,281,292,429 bytes. The recorded original pre-pull free space 15,160,532,992 bytes passes by 879,240,563 bytes. A build with the image already present requires 9,126,805,504 free bytes before starting and retains the 6 GiB live disk guard. These are explicit capacities, not compression-ratio assumptions.

After the Chair releases the build slot and sources/image are separately verified and available:

```bash
bash experiments/legacy-audio-decoder/build.sh /absolute/pristine/FFmpeg /absolute/new/private-output
```

The script refuses an existing output folder and never fetches sources or implicitly pulls an image. It runs the pinned container with no network, read-only source/recipe mounts and a new output directory. The private build uses make -j1 inside a 2-CPU, 4 GiB memory (no extra swap), 256-process container with a 512 MiB exec,nosuid,nodev temporary filesystem. Temporary execution is confined to this disposable build container so pinned configure probes can run; it adds no host or audio-request execution interface. The first build failed its shell sanity probe under the default noexec mount; exit1, configure log and actual container limits were retained before owned-container cleanup. A host watchdog kills the owned container after 1,800 seconds, at a 2 GiB output limit or below 6 GiB free host disk. Docker setup and cleanup commands have separate bounded timeouts. Actual container configuration/state, OOM flags, build logs and resource failures are saved before cleanup; an OOM or watchdog failure cannot become a successful build. The Docker image must already be present by its exact digest; the recipe never pulls implicitly. Configuration and compiler output, static libraries and the wrapper object remain available for review/relinking. No runtime host filesystem or process-execution interface is added.

`package-assets.py` rejects components outside the closed profile and GPL/nonfree/version3/network/thread settings. Its result stays `private-unqualified` with `distributionApproved: false`; packaging cannot grant qualification. Actual import inspection, ABI compilation and fixed-memory enforcement remain required.

## First private format profile

Demuxers: MP3, FLAC, Ogg, ADTS AAC and ordinary non-fragmented MP4/M4A with an initial ftyp box. Decoders: native MP3 float, FLAC, Vorbis, Opus, AAC LC/HE/HEv2 and ALAC. Select actual containers; extensions and MIME types are not proof.

The profile rejects multiple streams, attached pictures, encrypted inputs, fragmented MP4, chained/multiplexed Ogg, Ogg FLAC and other Ogg codecs, unqualified AAC profiles and changes after the first actual decoded geometry. Some valid older files will be refused. Rejected sources must remain in old storage.

Native Opus requires libswresample for intrinsic SILK/hybrid reconstruction; its output is fixed at 48 kHz in the pinned decoder. That internal dependency is allowed. AAC SBR/PS reconstruction may produce a higher rate or stereo output than its core header suggests. The first actual AVFrame establishes rate and channel layout; later changes reject. No application sample-rate conversion, downmix, loudness normalization or DSP controls are exposed. Bitstream-defined decoding semantics and gapless/edit handling still need explicit native comparisons.

Only avformat, avcodec, swresample and avutil are linked. There are no CLI programs, encoders, muxers, video decoder or DIRAC parser components, filters, device libraries, network protocols or externally opened inputs. The pinned Ogg demuxer does compile internal header handlers for Dirac/old Dirac, FLAC, OGM, Skeleton, Speex, Theora and VP8; configure selects the dirac_parse helper. These are disclosed linked dependencies, not admitted input formats. Strict BOS preflight rejects every identifier except the narrow Vorbis/Opus profiles before module fetching or decoder opening. Actual static-library symbols are preserved in static-symbols.txt; final module symbols and reachability still require review.

## C ABI and data flow

`decoder.h` defines ABI 1. One instance opens one selected input through custom bounded AVIO. It emits interleaved stereo Float32 in at most 4,096-frame chunks; mono duplicates its one source channel. It preserves finite headroom and floating negative zero where the decoder sample format permits. It does not clamp samples to unity or quantize to S16.

Decoded frame counts, sample rates and channels come from AVFrames, never declared duration. The C wrapper rejects corrupted frames/packets and changed/new codec parameters. Codec-specific strict-error behavior is not assumed universal; malformed-input tests are a required gate.

`envelope.mjs` reads bounded File slices in a DedicatedWorker. Its Ogg preflight requires one complete identification packet alone on the first BOS page: Vorbis v0 with the exact 30-byte header, mono/stereo layout, bounded native-rate header, valid block exponents and framing flag; or a 19-byte OpusHead v1, mono/stereo, mapping family 0. Opus input-rate metadata does not select its output rate. It also checks page extents, one serial, sequence, CRC, continuation/lacing agreement, an 8 MiB packet ceiling and complete terminal-page structure; its MP4 preflight bounds atom sizes/count/depth and rejects fragmentation. These checks do not replace FFmpeg parser qualification or prove absence of every hidden container payload.

`decoder.worker.mjs` uses a fixed-asset ES module and one fixed 64 MiB imported WebAssembly.Memory with equal initial/maximum limits. Emscripten FILESYSTEM=0, DYNAMIC_EXECUTION=0 and ALLOW_MEMORY_GROWTH=0 are required. No generic unsafe-eval allowance, remote URL, arbitrary import or secondary input is exposed. The exact built Wasm is hash-checked before initialization.

One chunk is transferred, then the Worker waits for its exact sequence acknowledgment. The parent validates frame/rate/channel/byte geometry and finite samples again, then copies each chunk into one pre-admitted output buffer. It retains no array of chunk objects. At EOF it creates a two-part Blob containing the canonical header and only the actual PCM bytes, drops its output-buffer reference, and terminates the decoder Worker before lowering ownership for Go CDR admission. No raw original or unvalidated candidate is downloaded or persisted.

`client.mjs` requires the real shared memory owner and an adapter that calls the existing Go CDR import. It returns only that adapter's canonical result with a retained owner. The caller must preserve old-source checks, durable fresh-ID save, compare-and-swap ownership and staged rollback, and dispose only after settlement.

## Resource policy

The source File and the existing 1 MiB bookkeeping allowance are charged before fetching module metadata. The parent reserves a conservative peak covering File snapshot, fixed maximum module/compilation allowance (independent of fetched size claims), fixed decoder heap, bounded I/O, output chunks/assembled WAV copies and the later current Go CDR preflight plus queue input owner. Admission uses at most 25 synchronous integer binary-search probes to select the largest output ceiling that fits before decoding. The shared resident owner must reject failed updates before changing its prior reservation, as the current helper does. Actual output exceeding that ceiling rejects the entire recovery; it never shortens the source.

Constants in the source lock include 200 MiB selected input, 16,777,216 maximum output frames, 64 KiB reads, 1,048,576 read/packet calls, 65,536 seeks, 1 MiB metadata/extradata and at most 4,096 frames in flight. Aggregate rereads are bounded. Input preflight and the decoder share bounded file access. Manifest and Wasm loading use fixed 16 KiB and 16 MiB buffers rather than retained chunk arrays. Empty chunks reject immediately; nonempty stream reads are limited to 1,024 and 4,096 respectively, plus the terminal EOF read. Terminal checks after awaited reads, hashing and module initialization prevent an errored late start from opening or pumping a decoder. The decoder's 8 MiB single-allocation guard is separate from its fixed 64 MiB aggregate linear memory.

A parent timer hard-terminates its DedicatedWorker after 130 seconds across asset loading, decoding and CDR, or on cancel/error/unmount. Go CDR must honor the same signal. Worker termination does not certify immediate operating-system memory reclamation or an arbitrary-browser wall-clock guarantee. A caller must bound its earlier storage reads and later durable-save/recheck phase too.

The Wasm asset is limited to 16 MiB, below the 25 MiB static-file ceiling; JS glue is capped at 4 MiB and all assets at 32 MiB. These are enforced packaging limits, not measured sizes. No sharding is introduced without an actual demonstrated need.

## Synthetic unit evidence

With Node 26.12.0 on PATH, `node --test experiments/legacy-audio-decoder/fixtures/*.test.mjs` passed 29/29 synthetic units in 80 ms during this source review. These exercise only envelope parsing, inert Worker/client protocol adapters, fixed-buffer stream reads and admission logic. No FFmpeg Wasm, real compressed decoder, browser or actual Go CDR ran.

Three additional inert Python units verify OOM/watchdog/disk failure status handling; these passed without contacting Docker. They do not verify kernel enforcement. The retained prior source failed the new one-frame chunk-retention, empty-manifest-read, exact-capacity and both late-initialization regressions before correction. The current tests cover 1,024 one-frame messages, bounded tiny/zero fetch chunks, exact frame admission, cancellation and late module settlement. This evidence does not establish real browser memory use or codec support.

## Qualification and license gates

Before any public integration:

1. Retain verified pristine official source/toolchain inputs and their provenance/hash receipts; enforce and inspect actual container resource limits; compile twice in clean fixed environments; inspect exact component lists, ABI/imports and fixed-memory behavior.
2. Compare every admitted format/profile/rate/channel against the same pinned native decoder, including FLAC/ALAC integer-to-Float32 conversion and lossy decode tolerances chosen before results.
3. Test MP3 delay/padding, Opus pre-skip/end trim, AAC SBR/PS first-frame geometry, MP4 edit lists, EOF tails, malformed metadata, packet bombs, CRC failures, encryption, chaining and parameter changes.
4. Exercise hard cancellation while C is busy, deadline, quota boundaries, memory ownership through actual termination/Go settlement, stale source and durable-save rollback. No partial result may publish.
5. Run actual same-origin browser/static cases under strict CSP with complete GET/HEAD-only request inventories, no user data and no raw-original exports.
6. Resolve exact LGPL corresponding-source, notice, modification and relinking obligations. Keep the decoder replaceable; publish approved source/build/relink material. A separate Worker does not erase license obligations.
7. Independently review QA/security/Writer/Product evidence; pass applicable repository gates and protected CI before merge or activation.

The current checkout has no blanket license grant for Aurialis. This experiment does not invent one. FFmpeg's LGPL license and corresponding source requirements must be handled before distributing any compiled core.

A local executable at another origin cannot automatically read a public origin's OPFS. Only an already validated clean PCM download could be manually imported elsewhere. Failed recovery retains the old original and its rollback prerequisite.

Primary references: [pinned FFmpeg configure](https://github.com/FFmpeg/FFmpeg/blob/bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa/configure), [native Opus reconstruction](https://github.com/FFmpeg/FFmpeg/blob/bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa/libavcodec/opus/dec.c), [AAC reconstruction](https://github.com/FFmpeg/FFmpeg/blob/bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa/libavcodec/aac/aacdec.c), [FFmpeg legal notes](https://ffmpeg.org/legal.html), [Emscripten settings](https://emscripten.org/docs/tools_reference/settings_reference.html), [File API](https://w3c.github.io/FileAPI/#FileReaderSync), [Worker termination](https://html.spec.whatwg.org/multipage/workers.html#dom-worker-terminate).
