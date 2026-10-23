<p align="center"><img src="public/favicon.svg" width="48" height="48" alt="Aurialis record mark"></p>

# Aurialis-WASM

**Bring a mix. Shape its sound. Keep it local.**

Aurialis is an audio mastering workstation that runs on your computer and opens in your browser. Start with a WAV file, adjust its tone, dynamics and stereo image, listen against the original, then export a new WAV. Mastering is the final shaping of a finished mix before you share it.

[Get started](#run-the-studio) · [Your first master](docs/getting-started.md) · [Documentation](docs/README.md) · [Developer guide](docs/development.md)

> **Project status:** active development, with a source build described below. Simple and Advanced share a working audio-processing chain. Deep offers static presets; source-driven AI analysis, timeline automation and validated instrument separation remain open work. See [current limits](#know-the-current-limits).

## A small studio, one clear path

```text
Your WAV  →  Choose a direction  →  Listen and refine  →  Download a WAV
                 Simple               Advanced             Export
```

| What you want to do | What Aurialis provides |
| --- | --- |
| Find a starting point | **Simple** genre, tone and intensity controls, plus an explicit **Set target loudness** action. |
| Shape the details | **Advanced** five-band EQ, compression, saturation, stereo controls, sample-peak limiting, De-Harsh and multiband dynamics. EQ changes tonal balance; compression controls changes in level. |
| Hear your decisions | **A Processed / B Original** listening, a measured live spectrum and waveform, and shared settings across Simple and Advanced. A/B does not automatically match loudness. |
| Make a handoff | **Export** as 16/24-bit PCM or 32-bit float WAV, preserving source sample rate and duration. Album rendering creates individual 24-bit WAV downloads. |

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

1. **Import a WAV.** Start with a short mono or stereo file. The studio initially opens in Advanced; select **Simple** for guided controls.
2. **Choose a direction.** Adjust genre, tone and intensity. These choices update the shared processing settings; you can refine them in Advanced.
3. **Listen.** Press Play and switch between **A Processed** and **B Original**. Volume controls listening level, not export gain. A louder result can sound more impressive, so judge tone and dynamics as well as loudness.
4. **Set loudness when needed.** Choose a target and press **Set target loudness** to measure the current settings and adjust input gain. Selecting a target alone does not normalize the track.
5. **Export.** Open Export, choose a bit depth, then press **Render & download WAV**. The default is 24-bit PCM. Export uses your current processing settings, including when you are listening to B Original.

See the [first-master guide](docs/getting-started.md) for control explanations, keyboard shortcuts, file formats and troubleshooting.

## Your audio and your computer

Audio processing runs in the browser and the local Go server; no cloud audio service is required. The server accepts connections only on your own computer's loopback address. It validates and reconstructs uploaded audio in memory, stripping container metadata.

Projects and settings are saved in this browser's local storage, and reconstructed source audio is saved in IndexedDB, the browser's local database. **Keep your original files and downloaded masters separately.** Browser storage can be cleared or evicted, and the reconstructed audio is not a byte-for-byte backup of your upload. Changing the server address, port or browser uses a different browser storage location.

## Know the current limits

| Area | Current boundary |
| --- | --- |
| Import | Mono/stereo WAV: 8/16/24/32-bit integer PCM or 32-bit float, 8–192 kHz. Compressed formats such as MP3, AAC and FLAC need conversion first. The API also accepts limited AIFF input; the browser import accepts WAV. |
| Track size | At most **128 MiB + 44 bytes** and **16,777,216 decoded frames**. The frame cap is about **5 min 50 s at 48 kHz**, or **2 min 55 s at 96 kHz**; file size can limit you sooner. |
| Processing | One expensive upload/render request at a time. A busy response asks you to retry. These are finite workstation limits. |
| Albums | Individual 24-bit WAVs in a **128 MiB temporary output cache**. Download them before leaving the album page or changing settings/order; there is no persistent mastered-output store or ZIP export. |
| Deep and Smart Split | Deep applies static tonal profiles. Musical analysis, editable automation, AI repair and validated instrument separation are unavailable in the product workflow. Experimental API jobs use deterministic heuristics, not trained models. |
| Reference and release checks | Reference blends another project's saved EQ settings; it does not analyze reference audio. Release checks measure rendered audio against working targets and do not certify platform delivery. |
| Audio guarantees | Hardware emulation and certified true-peak limiting remain open work. Live playback may be resampled to the audio device's rate; live and exported samples are not promised to be identical across rates. |

The [architecture](docs/architecture.md), [API contract](docs/api.md) and [task tracker](docs/tasks.md) document the exact boundaries and recorded verification evidence.

## Under the hood

**One executable, two places to process audio.** A Go server serves the embedded Next.js 16 / React 19 interface and HTTP API. During listening, shared Go DSP code runs as a WebAssembly reactor inside the browser's AudioWorklet. Export renders through the native Go implementation. Simple and Advanced edit the same canonical settings.

See [architecture](docs/architecture.md) for the audio paths, shared-memory controls, resource bounds and security model, or [API reference](docs/api.md) to render audio from a script.

## Help improve Aurialis

[Report a problem](https://github.com/yegamble/aurialis-WASM/issues) with what you expected, what happened, your browser, tool versions and steps to reproduce it. A short description of the audio format and duration helps with import or playback issues.

For code changes, start with the [developer guide](docs/development.md) and [`AGENTS.md`](AGENTS.md). The repository's [War Room guide](.claude/agents/README.md) describes its specialist agents and review workflow. Test requirements and historical results live in the docs rather than serving as a claim that every check passes on every checkout.

**License:** this checkout does not include a license file. Confirm permission with the maintainer before redistributing or reusing the code.
