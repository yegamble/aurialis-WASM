# Your first master

Bring in a WAV, find a direction you like, and download a new version. Your first session can stay entirely in **Simple** mode.

Need to launch Aurialis first? Follow the [README setup steps](../README.md#run-the-studio). Keep the local server running while you work.

## 1. Bring in a track

On **Home**, drop a WAV onto the upload area or choose a file. The library starts empty; there are no bundled songs.

Use an uncompressed mono or stereo WAV at **8–192 kHz**: 8/16/24/32-bit integer PCM or 32-bit float. Mono is converted to stereo. The browser import does not accept MP3, FLAC, OGG, M4A, AAC or AIFF. The [API reference](api.md#security-and-resource-contract) describes its additional, limited AIFF support.

Aurialis validates the file on the local Go server, rebuilds its audio into a clean stereo-float WAV, prepares a waveform, and saves that reconstructed source in this browser. Select **Cancel import** to stop it. Keep your original file separately: the stored version does not retain the original container metadata.

The file cap is **128 MiB plus a 44-byte WAV header**, with at most **16,777,216 decoded frames**. That is about **5 min 50 s at 48 kHz**, or **2 min 55 s at 96 kHz**; the file-size limit may shorten this. Longer recordings need a shorter selection or a lower sample rate before import. Lowering bit depth alone does not increase the frame limit.

When import succeeds, your track opens in the mastering workspace in **Advanced** mode. Select **Simple** to follow the next steps.

## 2. Find the feeling

Choose a **Genre**, a **Tone intention**, and an **Intensity**. These apply preset settings that you can hear during playback. They are starting points; they do not analyze the song or decide what sounds best.

Use **Play**, then compare **A Processed** with **B Original**. Both follow the same playback position. A is selected by default. There is no automatic volume matching between them, so a louder version can seem more impressive even when its tone is less useful.

Simple and Advanced share one set of processing settings. Switching tabs preserves your sound. Choosing a new Genre, Tone intention or Intensity replaces that shared processing direction, including custom Advanced edits.

## 3. Set the level, if you need to

Choose an **Output target**, then select **Set target loudness**. Aurialis measures the current chain and adjusts its input gain toward the requested average loudness. It then prepares an offline preview. If the target cannot be reached within the supported processing and peak limits, it reports an error.

Selecting a target alone does not measure or normalize the whole track. If you change processing afterward, run **Set target loudness** again when you want a fresh measurement. Targets are working preferences, not a promise that a streaming service will accept or preserve that level.

You can also select **Render offline preview** for a full-track render using the current settings. Once ready, **Download offline preview** saves that preview. Live playback updates independently; a preview becomes out of date when the processing settings change.

## 4. Export a WAV

Select **Export**, choose a bit depth, then select **Render & download WAV**.

| Choice | What it saves |
| --- | --- |
| **24-bit PCM** | The default integer WAV export. |
| **16-bit PCM** | A lower-bit-depth integer WAV. |
| **32-bit Float** | A float WAV that can retain audio above integer full scale. |

Exports keep the source sample rate and frame count. Integer exports clip samples outside ±1; enable the sample-peak limiter or reduce gain before exporting a signal that exceeds that range. The limiter is not a certified true-peak limiter.

Export always renders the current processing settings from the reconstructed source. Listening to **B Original**, changing monitor volume, or leaving an older offline preview on screen does not change those export settings. The download is a separate file; keep it and your original source in your own backup.

## Go further when you are ready

| In the app | Use it for |
| --- | --- |
| **Advanced** | Adjust input gain, five-band EQ, compression, saturation, stereo width, a sample-peak limiter, De-Harsh and three-band compression. These controls change the shared chain used by Simple and export. |
| **Deep** | Apply one of five static **Engineer profiles**, then refine it in Advanced. Profiles apply throughout the track. Musical section detection, timeline automation and AI repair are unavailable. |
| **Albums** | Create and order a sequence, then select **Render album masters** to measure and render individual 24-bit WAVs. Download them before leaving the page. |
| **Reference match** in **Tools** | Blend another project's saved EQ settings, with low-end and width options. Recorded audio spectrum matching remains in development. |
| **Release check** in **Tools** | Select Streaming, Dynamic or Spoken word, then **Run release check** to measure rendered audio against working targets. **Download JSON report** saves the measurements. This is guidance, not platform certification. |
| **Smart stem splitter** | Inspect the intended layout. Instrument separation, stem playback and stem downloads are unavailable. |

Album downloads use a **128 MiB total cache**. Changing the sequence or processing settings invalidates them; leaving the album page discards them. Render a smaller sequence or export tracks individually if it exceeds the cache. Album rendering does not establish full album-consistency mastering.

## Playback and keyboard shortcuts

Tap **Restart track** to return to the beginning. The forward control opens the next Library track when one is available; otherwise it skips ahead ten seconds. Hold either control to scrub through the track. **Repeat track** loops the current track.

| When focused on… | Shortcut |
| --- | --- |
| The waveform | Left/Right seeks one second; Shift seeks ten seconds; Alt seeks a tenth of a second. Home returns to the start; End goes to the end. |
| A mastering slider | Arrow keys adjust its value. Backspace or double-click resets it to its default. |
| An EQ point | Left/Right changes frequency; Up/Down changes gain. Backspace or double-click resets its frequency and gain. |
| A dialog | Escape closes it. |

## Where your work lives

Audio processing uses the browser and your local Go server. The standard app does not require a cloud audio service or an account. Build-time dependency downloads are separate from audio processing.

Reconstructed audio lives in **IndexedDB**, the browser's local database. Project settings and album metadata live in **localStorage**, another browser storage area. Use the same browser profile and local address to return to that workspace. Changing the host or port uses a different browser storage location.

Browser storage is not a backup: clearing site data, switching profiles, or storage failure can make your work unavailable. If Aurialis warns that storage is unavailable, keep the tab open and export before leaving; the audio fallback lasts only in memory. Re-import a missing source from your original file.

## If something gets stuck

| What you see | What to try |
| --- | --- |
| The local page will not open | Check that `./aurialis` is still running and use the address it is serving. See [startup and configuration](development.md). |
| “Failed to fetch” or a local-server connection error | Confirm the local server is running at the page's address, then retry. The message alone does not establish why the connection failed. |
| The server is busy | Let the current import or render finish, or cancel it, then retry. One expensive audio request is admitted at a time. |
| Import rejects the file | Check its format, channel count, size and duration against step 1. Renaming a compressed file to `.wav` does not convert it. |
| “The source audio is missing” | Use **Retry source** if offered. If the source is still unavailable, import the original file again to create a new project. |
| Playback initialization fails | Select **Retry playback** when shown, then Play. A current Chromium-based browser is a useful starting point; recorded Chromium/Brave results do not establish support for every browser or device. |
| The requested loudness cannot be reached | Choose a less demanding target or change processing, then run **Set target loudness** again. |
| An album exceeds its download cache | Render a smaller sequence or export its tracks individually. |

For a bug report, include your browser and operating system, the action that failed, the exact message, and the file's format, size, sample rate and channel count. Avoid sharing private audio unless you intend to.

## A small audio glossary

| Term | Plain-language meaning |
| --- | --- |
| **Mastering** | Adjusting the tone, dynamics and level of a finished mix before delivery. |
| **EQ / equalizer** | Controls that raise or lower parts of the frequency range, such as bass or treble. |
| **Compression** | Reduces level differences once the signal crosses a threshold. |
| **Saturation** | Adds nonlinear coloration and harmonics. Aurialis's named characters are original algorithms, not verified hardware replicas. |
| **Limiter / ceiling** | Restricts peaks toward a chosen maximum. The current limiter controls sample peaks; it does not certify inter-sample peaks. |
| **LUFS** | A measure of perceived loudness over time. A less negative reading generally means a louder signal. |
| **dBFS** | Level relative to digital full scale. For integer PCM, 0 dBFS is the maximum sample level. |
| **Sample rate** | Samples per second; 48 kHz means 48,000 samples per second per channel. |
| **Bit depth** | How sample values are represented. Float WAV can preserve headroom beyond the integer PCM range. |
| **DSP / WASM** | Digital signal processing is the audio math. WebAssembly lets the Go processing engine run in the browser. |

[Back to the README](../README.md) · [All documentation](README.md) · [Processing architecture](architecture.md)
