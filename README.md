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

Aurialis is an audio mastering workstation that runs on your computer and opens in your browser. Start with a WAV, AIFF, FLAC or MP3 file, adjust its tone, dynamics and stereo image, listen against the original, then export a new WAV. Mastering is the final shaping of a finished mix before you share it.

<p align="center">
  <a href="#run-the-studio">Get started</a> ·
  <a href="docs/getting-started.md">Your first master</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/development.md">Developer guide</a>
</p>

> **Project status:** active development, with a source build described below. Simple and Advanced share a working audio-processing chain. Deep adds measured proposals and editable source-frame automation with explicit Apply/Revert; Reference offers measured proposals for review. Smart Split separates 2–6 stems with a trained model in the desktop app. AI repair and certified hardware/true-peak behavior remain open work. Deep and Release are merged with their bounded workflows verified. Browser processing is merged, and both public addresses passed their scoped hosted checks. See [current limits](#know-the-current-limits).

## A small studio, one clear path

```text
Your audio  →  Choose a direction  →  Listen and refine  →  Download a WAV
                 Simple               Advanced             Export
```

| What you want to do | What Aurialis provides |
| --- | --- |
| Find a starting point | **Simple** genre, tone and intensity, Precise/Organic/Elevated styles, Depth/Presence, and an explicit **Set target loudness** action. |
| Shape the details | **Advanced** five-band EQ, compression, saturation, stereo controls, sample-peak limiting, De-Harsh and multiband dynamics. EQ changes tonal balance; compression controls changes in level. |
| Hear your decisions | **A Processed / B Original** listening, a measured live spectrum and waveform, and shared settings across Simple and Advanced. A/B does not automatically match loudness. |
| Understand and compare | **Deep** proposes bounded, editable changes over source-frame intervals; review them before Apply. **Reference** compares your current starting chain with another track's original audio and proposes bounded EQ and optional width changes. |
| Make a handoff | **Export** as 16/24-bit PCM or 32-bit float WAV at the source rate or converted to 44.1, 48, 88.2 or 96 kHz, with TPDF dither or none, preserving duration. **Release check** measures and retains the exact encoded WAV for download. Album rendering creates individual 24-bit WAV downloads. |

The interface follows a warm paper-and-ink design, with a focused listening area and detailed controls when you need them. Aurialis-WASM builds on [Aurialis](https://github.com/yegamble/Aurialis); this repository contains the Go, Next.js and WebAssembly implementation.

## Run the studio

The commands below build from source in a **Bash-compatible shell**. You need Git and these pinned tools installed and available in your terminal:

| Tool | Version | Used for |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | `26.12.0` | Building the browser interface |
| [pnpm](https://pnpm.io/installation) | `10.33.0` | Installing JavaScript dependencies; use pnpm for this repository |
| [Go](https://go.dev/doc/install) | `1.26.10` | Building the local server and audio modules |

The versions are recorded in [`.mise.toml`](.mise.toml), [`.nvmrc`](.nvmrc), [`package.json`](package.json) and [`go.mod`](go.mod). If someone has already built the executable for you, you can run that executable without Node.js or Go installed; you still need a browser with WebAssembly, AudioWorklet and shared-memory support.

```bash
git clone https://github.com/yegamble/aurialis-WASM.git
cd aurialis-WASM
pnpm install --frozen-lockfile
pnpm run build:binary
./aurialis
```

Leave the terminal running and open **[http://127.0.0.1:8080](http://127.0.0.1:8080)** on the same computer. You should see an empty studio ready to import audio. Press **Ctrl+C** in the terminal to stop the server.

The build embeds the interface, fonts, audio modules and worklets in one `aurialis` executable. A plain `go build` does not rebuild those assets. For build verification, another port or development commands, use the [developer guide](docs/development.md).

## Your first master

1. **Import a WAV, AIFF, FLAC or MP3.** Start with a short mono or stereo file. The first imported track opens in Advanced; select **Simple** for guided controls. You can import multiple files in one queue and find the others in Library.
2. **Choose a direction.** Adjust genre, tone, style, modifiers and intensity. These update the shared settings while retaining explicit input gain and output targets. Elevated checks the rendered candidate before accepting it.
3. **Listen.** Press Play and switch between **A Processed** and **B Original**. Volume controls listening level, not export gain. A louder result can sound more impressive, so judge tone and dynamics as well as loudness.
4. **Set loudness when needed.** Choose a target and press **Set target loudness** to measure the current settings and adjust input gain. Selecting a target alone does not normalize the track.
5. **Export.** Open Export, choose a bit depth, sample rate and dither, then press **Render & download WAV**. The default is 24-bit PCM at the source rate with TPDF dither. Export uses your current processing settings, including when you are listening to B Original. With Deep attached, it uses the acknowledged applied snapshot; draft or pending settings are excluded.

See the [first-master guide](docs/getting-started.md) for control explanations, keyboard shortcuts, file formats and troubleshooting.

For changes across the track, open **Deep**, choose an engineer profile and select **Analyze Deep proposal**. Analysis and edits leave playback unchanged. Review the neutral sections, select a move to edit its points, then select **Apply Deep proposal**. Mute/solo choices affect both live playback and export only after Apply. **Revert before first Apply** restores the saved starting settings; **Detach automation** retains the applied static baseline. [The Deep guide](docs/getting-started.md#review-and-apply-a-deep-proposal) explains drafts, recovery and the limits.

For a measured handoff, open **Release check** in Tools. Choose a destination and bit depth, run the review, then download the same WAV that was measured and its JSON report. Memory admission precedes source loading and includes the live source, inspection copies and retained downloads. Saving a report retains measurements, not the audio file; after reload, rerun before downloading a measured WAV. [The release guide](docs/getting-started.md#review-the-wav-you-will-hand-off) explains the profile scopes and manual checks.

## Your audio and your computer

Aurialis keeps audio processing on your device. The browser build reconstructs, analyzes and renders audio in local Web Workers using the shared Go engine. The local executable offers the same Go processing through its own loopback server. Both paths validate and reconstruct audio in memory, stripping container metadata.

Cloudflare serves only application, WASM and qualified model files. The browser build sends no audio uploads and does not automatically connect to a local server. Browser processing merged in [PR #16](https://github.com/yegamble/aurialis-WASM/pull/16); [the verification record](docs/browser-local.md#verification-status) retains its bounded evidence. The new app now serves [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and [aurialis.yosef.app](https://aurialis.yosef.app/). Each address passed all 12 hosted browser checks; broader product acceptance remains open.

Projects and settings are saved in this browser's local storage, and reconstructed source audio is saved in IndexedDB, the browser's local database. **Keep your original files and downloaded masters separately.** Browser storage can be cleared or evicted, and the reconstructed audio is not a byte-for-byte backup of your upload. Changing the server address, port or browser uses a different browser storage location. Replacing the older public app also requires separately verified local recovery of selected supported WAVs through CDR, while preserving its older library and unsupported compressed originals. Selected WAV recovery is qualified; compressed clean PCM recovery remains required before permanently retiring rollback resources.

**Library → Find old projects** finds saved source files only after you request it. Selected WAVs become independent projects with default settings; old audio, scripts and settings remain untouched. This bounded recovery workflow merged in [PR #17](https://github.com/yegamble/aurialis-WASM/pull/17). [The recovery guide](docs/legacy-library.md) explains the separate browser/site storage and compressed-format limits.

The first public-domain trial was rolled back after Cloudflare injected an external analytics script. The response-header and Reference review-state corrections then merged in [PR #18](https://github.com/yegamble/aurialis-WASM/pull/18), followed by successful checks on both public addresses. The older app’s resources remain intact until compressed recovery is qualified. [The task record](docs/tasks.md#reference-state-and-public-domain-trial) retains the failed trial and exact deployment evidence.

## Deployment

GitHub Actions deploys the site to Cloudflare Workers. Every deploy uses the browser build that CI already tested; nothing is rebuilt for release.

- **Production**: each push to `main` that passes every CI gate deploys the `aurialis-wasm` Worker (`deploy/cloudflare/wrangler.jsonc`) to [aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/) and [aurialis.yosef.app](https://aurialis.yosef.app/). Then it smoke-tests both domains. Deploys queue rather than overlap. The job summary records the Worker version id.
- **Branch previews**: Cloudflare Workers Builds, connected in the Worker's dashboard settings, builds every non-`main` branch into an isolated Worker Preview. It comments the preview URL on the branch's pull request, and the URL updates on every push. Its production deploy command is `wrangler versions upload`, so only GitHub Actions changes production.
- **Rollback**: run the **Cloudflare Rollback** workflow from `main` with an earlier Worker version id.

The GitHub workflows need the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Create the token from the *Edit Cloudflare Workers* template, scoped to this account and the `yosefgamble.com` and `yosef.app` zones.

## Know the current limits

| Area | Current boundary |
| --- | --- |
| Import | Mono/stereo WAV (including extensible headers) and AIFF/AIFF-C: 8/16/24/32-bit integer PCM or 32-bit float, 8–192 kHz. Mono/stereo FLAC (4–32-bit, 8–192 kHz, CRC and MD5 verified) and MPEG-1/2 Layer III MP3 (16–48 kHz, LAME/Lavc gapless trimming, decoded to float without clipping). AAC, Ogg, M4A, MPEG-2.5 and free-format MP3 need conversion first. |
| Track size | At most **256 MiB + 44 bytes** and **33,554,432 decoded frames**. The frame cap is about **11 min 39 s at 48 kHz**, **12 min 40 s at 44.1 kHz**, or **5 min 49 s at 96 kHz**; file size can limit you sooner. In the browser, memory admission can stop shorter tracks: Chrome on an 8 GB-class machine takes the full length; desktop Safari and Firefox take about 9½ minutes at 48 kHz; phones and 4 GB devices less. |
| Processing | One expensive browser job and at most one waiting job, with both inputs charged against memory. Browser memory preflight may reject smaller files, and retained masters also need memory; use the local executable within its own limits. The local server also bounds admission. |
| Albums | Each 24-bit master is saved in browser storage (IndexedDB) as it renders and stays available across reloads until the sequence or settings change. Download them one by one or as a single uncompressed ZIP. Rendering checks free browser storage first. If browser storage is unavailable, masters fall back to a **128 MiB in-memory cache** that is lost when you leave the page. **Delete album** removes its saved masters. |
| Deep and Smart Split | Deep provides measured source diagnostics, editable automation and separate legacy static profiles. Change points do not identify verses or choruses; AI repair remains unavailable. Smart Split runs a trained BS-RoFormer model locally in the desktop app only (not the browser build). The first split downloads a 176 MB model from this repository's `stem-model-v1` release into your user cache, verified by SHA-256. It is slow: on an idle 8-core M2 MacBook Air each 20-second model window takes about 32 s (a four-minute song needs 27 windows, about 15 minutes), and a busy or hot machine measured up to about three minutes per window. Linux and Windows use a plain-Go path that is at least 18 times slower. Songs up to 16,777,216 frames (about 5.8 minutes at 48 kHz) fit. On the one measured test track, vocals, drums, bass and guitar separated at 12–16 dB SI-SDR; piano and Other are weak. ScriptV2 keeps sonic algorithm 1, its proposals' Optical compression and sample-peak limiting; it uses deterministic heuristics, not a trained mastering model. |
| Reference | Reference analyzes original reference audio against your source through its starting settings, with explicit proposal review and Apply/Revert. Saved reference knob positions are ignored; broad-band similarity does not establish perceptual matching. Both audio files share one **129 MiB** request ceiling. |
| Release | Reviews the exact 16/24/32-bit WAV against six scoped destination profiles. It never changes gain, trims or resamples. Guidance and diagnostic measurements do not certify platform delivery, codec peaks, metadata, Digital Masters status or a manufactured CD. |
| Audio guarantees | Hardware emulation and certified true-peak limiting remain open work. Offline renders can opt into `algorithmVersion: 2`, which limits the reconstructed peak to the ceiling. Browser exports (WAV download, album render and release check) use it; previews and live playback stay on algorithm 1, so on content with intersample peaks an export limits harder than what you heard. Live playback may be resampled to the audio device's rate; live and exported samples are not promised to be identical across rates. |

The [architecture](docs/architecture.md), [API contract](docs/api.md) and [task tracker](docs/tasks.md) document the exact boundaries and recorded verification evidence.

## Under the hood

**Shared Go processing on your device.** The executable embeds the Next.js 16 / React 19 interface and local HTTP API. The browser build runs reconstruction, analysis and export in disposable Go/WASM workers. Both builds use shared Go DSP in the browser’s AudioWorklet for listening, with live momentary, short-term and integrated LUFS, loudness range, true peak and gain-reduction meters measured on the processed output. Simple and Advanced edit the same canonical settings.

See [architecture](docs/architecture.md) for the audio paths, shared-memory controls, resource bounds and security model, or [API reference](docs/api.md) to render audio from a script. The [ScriptV2 contract](docs/api.md#scriptv2-foundation) binds editable proposals and acknowledged live/export schedules to verified source audio. Draft edits wait for explicit Apply.

Simple merged in [PR #11](https://github.com/yegamble/aurialis-WASM/pull/11), followed by Deep in [PR #13](https://github.com/yegamble/aurialis-WASM/pull/13) at `6154f87`. Deep passed the corrected 102-case browser suite locally and both exact-head Linux runs; the original 101/102 result and its stale-message correction remain in [the task record](docs/tasks.md#full-combined-verification-and-main-rebase). Release merged in [PR #15](https://github.com/yegamble/aurialis-WASM/pull/15) at `01c2c15` after 406 units and all 107 browser cases passed final-head CI. Its [post-merge workflow](https://github.com/yegamble/aurialis-WASM/actions/runs/40014809849) also succeeded; those individual browser counts were not separately inspected. The browser-local branch subsequently passed 434 units, all 107 native-loopback cases and eight static Worker cases, with 233 observed body-free GET/HEAD requests. [The evidence record](docs/browser-local.md#verification-status) binds these local results to their source. These counts do not certify the whole product or hosted deployment.

## Help improve Aurialis

[Report a problem](https://github.com/yegamble/aurialis-WASM/issues) with what you expected, what happened, your browser, tool versions and steps to reproduce it. A short description of the audio format and duration helps with import or playback issues.

For code changes, start with the [developer guide](docs/development.md) and [`AGENTS.md`](AGENTS.md). Pull requests run fresh checks against a verified build, with individual browser tests split across three isolated runners and one audio worker per runner. Browser package setup has separate bounded steps. Playback comparisons use full measured windows and a known gain change to check measurement sensitivity. [The CI guide](docs/development.md#how-ci-reuses-builds-and-runs-checks) explains build artifacts, caches and the six required gates. The repository's [War Room guide](.claude/agents/README.md) describes its specialist agents and review workflow. Test requirements and historical results live in the docs rather than serving as a claim that every check passes on every checkout.

**License:** [MIT](LICENSE). Bundled third-party notices are in [`public/licenses/`](public/licenses/), and the Smart Split model weights are MIT-licensed by their author.
