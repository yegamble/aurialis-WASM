<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/aurialis-logo-dark.svg">
    <img src="docs/assets/aurialis-logo.svg" width="480" alt="Aurialis">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/yegamble/aurialis-WASM/actions/workflows/ci.yml"><img src="https://github.com/yegamble/aurialis-WASM/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <a href="go.mod"><img src="https://img.shields.io/badge/Go-1.26.10-00ADD8?logo=go&amp;logoColor=white" alt="Go 1.26.10"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&amp;logoColor=white" alt="Next.js 16"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/React-19-149ECA?logo=react&amp;logoColor=white" alt="React 19"></a>
  <a href="docs/architecture.md#browser-audio-paths"><img src="https://img.shields.io/badge/WebAssembly-654FF0?logo=webassembly&amp;logoColor=white" alt="WebAssembly audio processing"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/pnpm-10.33.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 10.33.0"></a>
</p>

<p align="center"><strong>Bring a mix. Shape its sound. Keep it local.</strong></p>

Aurialis is an audio mastering workstation that runs in your browser: open [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and your audio is processed on your device, never uploaded. Start with a WAV, AIFF, FLAC or MP3 file, adjust its tone, dynamics and stereo image, listen against the original, then export a new WAV. Mastering is the final shaping of a finished mix before you share it.

<p align="center">
  <a href="#run-the-studio">Get started</a> ·
  <a href="docs/getting-started.md">Your first master</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/development.md">Developer guide</a>
</p>

> **Project status:** active development. The browser build at [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and [aurialis.yosef.app](https://aurialis.yosef.app/) is the v1 release target; a native single binary, built from source, is the fallback for files beyond a browser's memory. Simple and Advanced share a working audio-processing chain. Deep adds measured proposals and editable source-frame automation with explicit Apply/Revert; Reference offers measured proposals for review. Smart Split runs only in the native Aurialis build, which you build from source; the browser build cannot separate stems. macOS uses Apple Accelerate; Linux and Windows are available only on the qualified AVX2/FMA backend. The hosted Linux window was 126.67 s and Windows 174.39 s, just 5.61 s below the 180 s gate; each passed five-head comparison (maximum error 2.98e−7, minimum SNR 105.4 dB). A two-window synthetic 48 kHz, 20-second source reconstructed six stems with maximum residual 3.73e−9; the pipeline took 249.87 s on Linux and 356.60 s on Windows. These hosted measurements are not device guarantees. Plain Go and the SSE3 fallback remain unavailable. Intel macOS remains unqualified: the latest profiled single window took 230.33 s (model load 0.68 s; setup 0.011 s), and no full song, cancellation or heap qualification has passed there. A 3:45 source needs 25 windows; a rough 3–4 minutes per window projects to 75–100 minutes and may exceed the 90-minute job limit. No full-song completion time is guaranteed. AI repair and certified hardware emulation are outside v1. No prebuilt binaries are published. See [current limits](#know-the-current-limits).

## A small studio, one clear path

```text
Your audio  →  Choose a direction  →  Listen and refine  →  Download a WAV
                 Simple               Advanced             Export
```

| What you want to do | What Aurialis provides |
| --- | --- |
| Find a starting point | **Simple** genre, tone and intensity, Precise/Organic/Elevated styles, Depth/Presence, and an explicit **Set target loudness** action. |
| Shape the details | **Advanced** five-band EQ, compression, saturation, stereo controls, sample-peak limiting, De-Harsh and multiband dynamics. EQ changes tonal balance; compression controls changes in level. |
| Hear your decisions | **A Processed / B Original** listening, a measured live spectrum and waveform, and shared settings across Simple and Advanced. Opt-in **Equal-loudness A/B** lowers the louder of A or B by one fixed, measured offset for listening only; export is unchanged. |
| Understand and compare | **Deep** proposes bounded, editable changes over source-frame intervals; review them before Apply. **Reference** compares your current starting chain with another track's original audio and proposes bounded EQ and optional width changes. |
| Make a handoff | **Export** as 16/24-bit PCM or 32-bit float WAV at the source rate or converted to 44.1, 48, 88.2 or 96 kHz, with TPDF dither or none, preserving duration. With the limiter on, a converted export is true-peak limited again at its new rate. With the limiter on, exports are band-limited, flat to 0.45 × the sample rate (19.85 kHz at 44.1 kHz), so their true peaks stay under the ceiling. The filter is minimum-phase and shifts the top octave's phase (about 1 ms of delay near 19.8 kHz at 44.1 kHz, under 0.04 ms below 15 kHz), so a limited master won't null against the source even with no gain reduction. **Release check** renders, measures and retains the WAV Export delivers at the chosen bit depth, sample rate and dither, such as 44.1 kHz/16-bit for CD. Album rendering creates one WAV per song at the album's delivery format (24-bit at each source rate by default; one rate makes a mixed-rate album uniform) that keeps each master's level or normalizes to a chosen target with per-track offsets, without changing the projects. |

During live playback, **Reset modules** keeps buffered limited audio protected while returning to the source, rather than releasing it without its gain reduction.

The interface follows a warm paper-and-ink design, with a focused listening area and detailed controls when you need them. Aurialis-WASM builds on [Aurialis](https://github.com/yegamble/Aurialis); this repository contains the Go, Next.js and WebAssembly implementation.

## Run the studio

Open **[aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/)** (or [aurialis.yosef.app](https://aurialis.yosef.app/)) in a current browser with WebAssembly, AudioWorklet and shared-memory support; a recent Chromium-based browser is a good starting point. There is nothing to install or sign in to, and you should see an empty studio ready to import audio. The [first-master guide](docs/getting-started.md) walks through a session.

### Build the native fallback from source

Build the native single binary when a file is too large for your browser's memory, or to use Smart Split. No prebuilt binaries are published. The commands below build from source in a **Bash-compatible shell**. You need Git and these pinned tools installed and available in your terminal:

| Tool | Version | Used for |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | `26.12.0` | Building the browser interface |
| [pnpm](https://pnpm.io/installation) | `10.33.0` | Installing JavaScript dependencies; use pnpm for this repository |
| [Go](https://go.dev/doc/install) | `1.26.10` | Building the local server and audio modules |

The versions are recorded in [`.mise.toml`](.mise.toml), [`.nvmrc`](.nvmrc), [`package.json`](package.json) and [`go.mod`](go.mod). The built executable runs without Node.js or Go installed; you still need a browser with WebAssembly, AudioWorklet and shared-memory support.

```bash
git clone https://github.com/yegamble/aurialis-WASM.git
cd aurialis-WASM
pnpm install --frozen-lockfile
pnpm run build:binary
./aurialis
```

Leave the terminal running and open **[http://127.0.0.1:8080](http://127.0.0.1:8080)** on the same computer. You should see an empty studio ready to import audio. Press **Ctrl+C** in the terminal to stop the server. Projects saved on the public site stay in that site's browser storage; the local studio starts with its own empty library.

The build embeds the interface, fonts, audio modules and worklets in one `aurialis` executable. A plain `go build` does not rebuild those assets. For build verification, another port or development commands, use the [developer guide](docs/development.md).

## Your first master

1. **Import a WAV, AIFF, FLAC or MP3.** Start with a short mono or stereo file. The first imported track opens in Advanced; select **Simple** for guided controls. You can import multiple files in one queue and find the others in Library.
2. **Choose a direction.** Adjust genre, tone, style, modifiers and intensity. These update the shared settings while retaining explicit input gain and output targets. Elevated checks the rendered candidate before accepting it.
3. **Listen.** Press Play and switch between **A Processed** and **B Original**. Volume controls listening level, not export gain. A louder result can sound more impressive, so judge tone and dynamics as well as loudness.
4. **Set loudness when needed.** Choose a target and press **Set target loudness** to measure the current settings and adjust input gain. Selecting a target alone does not normalize the track.
5. **Export.** Open Export, choose a bit depth, a sample rate and, for 16/24-bit PCM, dither, then press **Render & download WAV**. The default is 24-bit PCM at the source rate with TPDF dither. Export uses your current processing settings, including when you are listening to B Original. With Deep attached, it uses the acknowledged applied snapshot; draft or pending settings are excluded.

See the [first-master guide](docs/getting-started.md) for control explanations, keyboard shortcuts, file formats and troubleshooting.

For changes across the track, open **Deep**, choose an engineer profile and select **Analyze Deep proposal**. Analysis and edits leave playback unchanged. Review the neutral sections, select a move to edit its points, then select **Apply Deep proposal**. Mute/solo choices affect both live playback and export only after Apply. **Revert before first Apply** restores the saved starting settings; **Detach automation** retains the applied static baseline. [The Deep guide](docs/getting-started.md#review-and-apply-a-deep-proposal) explains drafts, recovery and the limits.

For a measured handoff, open **Release check** from the track's Master view, or choose the track in **Tools** (it starts on the newest import and remembers your choice while the tab is open). Choose a destination and bit depth, run the review, then download the same WAV that was measured and its JSON report. Memory admission precedes source loading and includes the live source, inspection copies and retained downloads. Browser job admission also estimates decoded source/reference capacity before worker creation: it reads FLAC STREAMINFO and bounded MP3 frame headers where reliable, and uses the global frame limit when shape is unknown. This is an admission estimate, not a browser memory or RSS guarantee; unusually large or ambiguous files may need the **native Aurialis build (built from source)**. Saving a report retains measurements, not the audio file; after reload, rerun before downloading a measured WAV. [The release guide](docs/getting-started.md#review-the-wav-you-will-hand-off) explains the profile scopes and manual checks.

Library Preview and Master both offer opt-in Equal-loudness A/B. With Repeat enabled, relative Forward and keyboard seeks wrap around the track; an explicit seek to the endpoint stops. A rendered audition has its own **Audition position** slider and accepts media-key seeking. The Deep timeline contains the four supported lanes; old repair switches are disabled during recovery.

## Your audio and your computer

Aurialis keeps audio processing on your device. The browser build reconstructs, analyzes and renders audio in local Web Workers using the shared Go engine. The local executable offers the same Go processing through its own loopback server. Both paths validate and reconstruct audio in memory, stripping container metadata.

Cloudflare serves only application, WASM and qualified model files. The browser build sends no audio uploads and does not automatically connect to a local server. Browser processing merged in [PR #16](https://github.com/yegamble/aurialis-WASM/pull/16); [the verification record](docs/browser-local.md#verification-status) retains its bounded evidence. The new app now serves [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and [aurialis.yosef.app](https://aurialis.yosef.app/). Each address passed all 12 hosted browser checks; broader product acceptance remains open.

Projects and settings are saved in this browser's local storage, and reconstructed source audio is saved in IndexedDB, the browser's local database. **Keep your original files and downloaded masters separately.** Browser storage can be cleared or evicted, and the reconstructed audio is not a byte-for-byte backup of your upload. Changing the server address, port or browser uses a different browser storage location. Replacing the older public app requires local recovery of selected WAV, AIFF, FLAC and MP3 sources through current Go CDR. Recovery creates independent projects with default settings and preserves old audio, scripts and settings; unsupported OGG, AAC and M4A originals remain in old storage. Keep rollback resources until the recovery workflow passes its remaining full product gates.

**Library → Find old projects** finds saved source files only after you request it. Selected WAV, AIFF, FLAC and MP3 sources become independent projects with default settings; old audio, scripts and settings remain untouched. Recovery is capped at 128 MiB per saved original, plus decoded frame and device-memory limits. Unsupported OGG, AAC and M4A files stay in old storage. [The recovery guide](docs/legacy-library.md) explains the separate browser/site storage.

The first public-domain trial was rolled back after Cloudflare injected an external analytics script. The response-header and Reference review-state corrections then merged in [PR #18](https://github.com/yegamble/aurialis-WASM/pull/18), followed by successful checks on both public addresses. The older app’s resources remain intact until compressed recovery is qualified. [The task record](docs/tasks.md#reference-state-and-public-domain-trial) retains the failed trial and exact deployment evidence.

## Deployment

GitHub Actions deploys the site to Cloudflare Workers. Every deploy uses the browser build that CI already tested; nothing is rebuilt for release.

- **Production**: each push to `main` that passes every CI gate deploys the `aurialis-wasm` Worker (`deploy/cloudflare/wrangler.jsonc`) to [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and [aurialis.yosef.app](https://aurialis.yosef.app/). Then it smoke-tests both domains. Deploys queue rather than overlap. The job summary records the Worker version id.
- **Branch previews**: Cloudflare Workers Builds, connected in the Worker's dashboard settings, builds every non-`main` branch into an isolated Worker Preview. It comments the preview URL on the branch's pull request, and the URL updates on every push. GitHub Actions is the only configured production deploy path; CI itself does not create branch previews.
- **Rollback**: run the **Cloudflare Rollback** workflow from `main` with an earlier Worker version id.

The deploy and rollback jobs run in the GitHub `Production` environment, which only `main` may deploy from. They need the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets; store them as `Production` environment secrets, not repository secrets. Create the token from the *Edit Cloudflare Workers* template, scoped to this account and the `yosefgamble.com` and `yosef.app` zones.

## Know the current limits

| Area | Current boundary |
| --- | --- |
| Import | Mono/stereo WAV (including extensible headers) and AIFF/AIFF-C: 8/16/24/32-bit integer PCM or 32-bit float, 8–192 kHz. Mono/stereo FLAC (4–32-bit, 8–192 kHz, CRC and MD5 verified) and MPEG-1/2 Layer III MP3 (16–48 kHz, LAME/Lavc gapless trimming, decoded to float without clipping). AAC, Ogg, M4A, MPEG-2.5 and free-format MP3 need conversion first. |
| Float headroom | Float WAV and AIFF-C preserve useful above-unity samples up to +36 dBFS (amplitude 63.09573444801933), recoverable with the −36 dB Input trim. Larger magnitudes are rejected rather than clipped. Integer FLAC must stay inside its declared sample range after stereo reconstruction. |
| Track size | At most **256 MiB + 44 bytes** and **33,554,432 decoded frames**. The frame cap is about **11 min 39 s at 48 kHz**, **12 min 40 s at 44.1 kHz**, or **5 min 49 s at 96 kHz**; file size can limit you sooner. In the browser, memory admission can stop shorter tracks: Chrome on an 8 GB-class machine takes the full length; desktop Safari and Firefox take about 9½ minutes at 48 kHz; phones and 4 GB devices less. |
| Processing | One expensive browser job and at most one waiting job, with both inputs charged against memory. Browser memory preflight may reject smaller files, and retained masters also need memory; use the local executable within its own limits. The native server shares a 2 GiB working-allocation budget across requests, jobs, retained results, downloads and the model; it reports capacity errors before allocating. |
| Albums | An album keeps each master's own export level by default, or normalizes every track to a chosen target plus a per-track offset; the level is saved on the album and projects are never changed. Each rendered master is measured, and the loudness and true-peak chart shows only those measurements. Each 24-bit master is saved in browser storage (IndexedDB) as it renders and stays available across reloads until the sequence or settings change. Download them one by one or as a single uncompressed ZIP. Rendering checks free browser storage first. If browser storage is unavailable, masters fall back to a **128 MiB in-memory cache** that is lost when you leave the page. **Delete album** removes its saved masters. |
| Deep and Smart Split | Deep provides measured source diagnostics, editable automation and one profile control; each proposal lists the settings it changes and its predicted export loudness, true peak and crest. Change points do not identify verses or choruses; AI repair remains unavailable. Smart Split runs a trained BS-RoFormer model on your computer in the native build only. The first split downloads a 176 MB model from this repository's published `stem-model-v1` release into your user cache, verified by SHA-256; after a restart the Split page says a verified cached model loads on the first split instead of downloading. Smart Split runs only in the native Aurialis build, which you build from source; the browser build cannot separate stems. macOS uses Apple Accelerate; Linux and Windows are available only on the qualified AVX2/FMA backend. The hosted Linux window was 126.67 s and Windows 174.39 s, just 5.61 s below the 180 s gate; each passed five-head comparison (maximum error 2.98e−7, minimum SNR 105.4 dB). A two-window synthetic 48 kHz, 20-second source reconstructed six stems with maximum residual 3.73e−9; the pipeline took 249.87 s on Linux and 356.60 s on Windows. These hosted measurements are not device guarantees. Plain Go and the SSE3 fallback remain unavailable. Intel macOS remains unqualified: the latest profiled single window took 230.33 s (model load 0.68 s; setup 0.011 s), and no full song, cancellation or heap qualification has passed there. A 3:45 source needs 25 windows; a rough 3–4 minutes per window projects to 75–100 minutes and may exceed the 90-minute job limit. No full-song completion time is guaranteed. The Apple-silicon M2 timings are 32 s idle and 173 s busy per 20-second window; those are separate one-host measurements. Songs up to 16,777,216 frames (about 5.8 minutes at 48 kHz) fit. On the one measured test track, vocals, drums, bass and guitar separated at 12–16 dB SI-SDR; piano and Other are weak. ScriptV2 proposals use Optical or VCA compression and a measured Level match gain; export and live playback use the project’s saved Classic or Oversampled quality with true-peak limiting. They come from deterministic heuristics, not a trained mastering model. |
| Reference | Reference analyzes original reference audio against your source through its starting settings, with explicit proposal review and Apply/Revert. Saved reference knob positions are ignored; broad-band similarity does not establish perceptual matching. Both audio files share one **257 MiB** request ceiling. |
| Release | Reviews the exact 16/24/32-bit WAV against six scoped destination profiles. It never changes gain, trims or resamples. Guidance and diagnostic measurements do not certify platform delivery, codec peaks, metadata, Digital Masters status or a manufactured CD. |
| Audio guarantees | Hardware emulation and platform certification are outside v1. The saved **Render quality** choice selects Classic (algorithm 2) or Oversampled (algorithm 3). Oversampled uses 2× processing for saturation with designed 129-tap half-band FIR filters; together they add 64 base-rate frames of fixed latency. The FIR improves rejection but does not bound aliasing generated above the 2× Nyquist limit. Classic (algorithm 2) band-limits the limiter input (flat to 0.45 × the sample rate, 19.85 kHz at 44.1 kHz) and limits the reconstructed peak to the ceiling; on a near-ideal reconstruction limited exports measure at least 0.13 dB under it. With the limiter on, the minimum-phase filter shifts the top octave's phase (about 1 ms near 19.8 kHz at 44.1 kHz), so an export won't null against the source even when no gain reduction occurs. Browser exports (WAV download, album render and release check), live playback and its meters use the saved quality choice with the true-peak limiter. Up to 48 kHz live playback runs at the source's sample rate, so what you hear as A is what you export (within 0.1 LU). Higher-rate sources play live at 44.1 or 48 kHz to stay within the live CPU budget, and a browser that refuses a rate plays at the device rate. In both cases the page says so: live can then differ from the export by about 0.2 LU, and **Audition export** renders and plays the exact export file instead, at the Playback volume and without Equal-loudness A/B. |

The [architecture](docs/architecture.md), [API contract](docs/api.md) and [task tracker](docs/tasks.md) document the exact boundaries and recorded verification evidence.

## Under the hood

**Shared Go processing on your device.** The executable embeds the Next.js 16 / React 19 interface and local HTTP API. The browser build runs reconstruction, analysis and export in disposable Go/WASM workers. Both builds use shared Go DSP in the browser’s AudioWorklet for listening, with live momentary, short-term and integrated LUFS, loudness range, true peak and gain-reduction meters measured on the processed output. Simple and Advanced edit the same canonical settings.

See [architecture](docs/architecture.md) for the audio paths, shared-memory controls, resource bounds and security model, or [API reference](docs/api.md) to render audio from a script. The [ScriptV2 contract](docs/api.md#scriptv2-foundation) binds editable proposals and acknowledged live/export schedules to verified source audio. Draft edits wait for explicit Apply.

Simple merged in [PR #11](https://github.com/yegamble/aurialis-WASM/pull/11), followed by Deep in [PR #13](https://github.com/yegamble/aurialis-WASM/pull/13) at `6154f87`. Deep passed the corrected 102-case browser suite locally and both exact-head Linux runs; the original 101/102 result and its stale-message correction remain in [the task record](docs/tasks.md#full-combined-verification-and-main-rebase). Release merged in [PR #15](https://github.com/yegamble/aurialis-WASM/pull/15) at `01c2c15` after 406 units and all 107 browser cases passed final-head CI. Its [post-merge workflow](https://github.com/yegamble/aurialis-WASM/actions/runs/40014809849) also succeeded; those individual browser counts were not separately inspected. The browser-local branch subsequently passed 434 units, all 107 native-loopback cases and eight static Worker cases, with 233 observed body-free GET/HEAD requests. [The evidence record](docs/browser-local.md#verification-status) binds these local results to their source. These counts do not certify the whole product or hosted deployment.

## Help improve Aurialis

[Report a problem](https://github.com/yegamble/aurialis-WASM/issues) with what you expected, what happened, your browser, tool versions and steps to reproduce it. A short description of the audio format and duration helps with import or playback issues.

For code changes, start with the [developer guide](docs/development.md) and [`AGENTS.md`](AGENTS.md). Pull requests run fresh checks against a verified build, with individual browser tests split across three isolated runners and one audio worker per runner. Browser package setup has separate bounded steps. Playback comparisons use full measured windows and a known gain change to check measurement sensitivity. [The CI guide](docs/development.md#how-ci-reuses-builds-and-runs-checks) explains build artifacts, caches and the six required gates. The repository's [War Room guide](.claude/agents/README.md) describes its specialist agents and review workflow. Test requirements and historical results live in the docs rather than serving as a claim that every check passes on every checkout.

**License:** [MIT](LICENSE). Bundled third-party notices are in [`public/licenses/`](public/licenses/), and the Smart Split model weights are MIT-licensed by their author.
