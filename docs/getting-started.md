# Your first master
<!-- cspell:words ISRC -->

Bring in a WAV, find a direction you like, and download a new version. Your first session can stay entirely in **Simple** mode.

Need to launch Aurialis first? Follow the [README setup steps](../README.md#run-the-studio). Keep the local server running while you work.

## 1. Bring in a track

On **Home**, drop WAV files onto the upload area, paste audio files from the clipboard, or select **Choose audio**. The library starts empty; there are no bundled songs.

Use an uncompressed mono or stereo WAV at **8–192 kHz**: 8/16/24/32-bit integer PCM or 32-bit float. Mono is converted to stereo. The browser import does not accept MP3, FLAC, OGG, M4A, AAC or AIFF. The [API reference](api.md#security-and-resource-contract) describes its additional, limited AIFF support.

Aurialis imports selected files one at a time. It validates each file on the local Go server, rebuilds its audio into a clean stereo-float WAV, prepares a waveform, and saves that reconstructed source in this browser. Invalid files are skipped with a reason. Select **Cancel import** to stop the queue; already imported projects remain in your Library. Keep your original files separately: the stored versions do not retain the original container metadata.

The file cap is **128 MiB plus a 44-byte WAV header**, with at most **16,777,216 decoded frames**. That is about **5 min 50 s at 48 kHz**, or **2 min 55 s at 96 kHz**; the file-size limit may shorten this. Longer recordings need a shorter selection or a lower sample rate before import. Lowering bit depth alone does not increase the frame limit.

When import finishes, the first successfully imported track opens in the mastering workspace in **Advanced** mode. Other imported projects are in **Library**. Select **Simple** to follow the next steps.

## 2. Find the feeling

Choose a **Genre**, a **Tone intention**, a **Mastering style**, and an **Intensity**. These are original creative starting points, not song analysis. **Precise** keeps a restrained curve; **Organic** eases compression and color. **Elevated** measures the complete candidate against peak and loudness upper bounds before accepting it, without adding automatic gain. If it rejects a candidate, your current sound stays in place; reduce **Input gain** in Advanced and retry, or choose another style.

**Depth** and **Presence** add optional low-frequency and upper-frequency contours. They combine once in either order. Metal and Jazz are also available as genre starting points.

Use **Play**, then compare **A Processed** with **B Original**. Both follow the same playback position. A is selected by default. There is no automatic volume matching between them, so a louder version can seem more impressive even when its tone is less useful.

Simple and Advanced share one set of processing settings. Switching tabs preserves your sound. Choosing a new genre, tone, style, modifier or intensity replaces other custom Advanced edits while retaining explicit **Input gain** and the selected loudness/ceiling. Manual edits clear active direction badges and remember the last style/modifiers. Zero intensity removes direction shaping while retaining explicit gain and limiter targets.

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

Export renders the current processing settings from the reconstructed source. With Deep attached, the acknowledged applied script is authoritative; draft edits and pending revisions are excluded. Listening to **B Original**, changing monitor volume, or leaving an older offline preview on screen does not change those export settings. The download is a separate file; keep it and your original source in your own backup.

## Go further when you are ready

| In the app | Use it for |
| --- | --- |
| **Advanced** | Adjust input gain, five-band EQ, compression, saturation, stereo width, a sample-peak limiter, De-Harsh and three-band compression. These controls change the shared chain used by Simple and export. |
| **Deep** | Analyze a measured proposal, edit source-frame moves and explicitly Apply its complete baseline/schedule. Separate source diagnostics and legacy static profiles remain available. Neutral sections do not identify musical roles; AI repair remains unavailable. |
| **Albums** | Create and order a sequence, then select **Render album masters** to measure and render individual 24-bit WAVs. Download them before leaving the page. |
| **Reference match** in **Tools** | Measure your track against another imported recording, review a bounded EQ and optional width proposal, then explicitly apply it. |
| **Release check** in **Tools** | Choose one of six destination profiles and an encoding, then review the exact rendered WAV. Download that measured file and its JSON report; saved reports retain measurements only. This is guidance, not platform certification. |
| **Smart stem splitter** | Inspect the intended layout. Instrument separation, stem playback and stem downloads are unavailable. |

Album consistency changes are under integration verification; see [current evidence](tasks.md#album-consistency--private-source-checkpoint). The new workspace offers −23/−18/−16/−14/−12/−9 LUFS targets. Its default shared gain preserves relative track levels and uses median track loudness, never album-integrated loudness. Individual normalization and manual-only offsets are explicit alternatives. All gain is capped by the finite peak estimate, a disclosed 0.01 dB encoding margin and the ±36 dB gain range; a target can remain unmet. Silent or very short sequences require manual-only gain.

Album downloads use a **128 MiB total cache**, with at most 64 tracks. Each accepted static or applied Deep chain is rendered first; album gain does not change individual settings. Cancellation retains only verified completed WAVs for an unchanged cohort, and retry continues that prefix. Source, order, metadata, target, offset or processing changes invalidate it; leaving the page discards all WAVs. Saved reports restore metadata only. Render a smaller sequence or export tracks individually if the cache or device budget rejects it. Tone and crest comparisons are descriptive working flags, not mastering quality scores or loudness range (LRA).

## Keep your Library organized

Use **Search your library**, status filters and **Sort projects** to find a project. Each row's action button opens its project actions:

| Action | What it does |
| --- | --- |
| **Preview** followed by the track title | Listen with that project's processing settings and A/B controls without opening Master. |
| **Duplicate settings** | Create an independent project and stored source copy for another direction. Restore a missing source before duplicating. |
| **Add to album** | Add the project to an existing album or create one with **New album with this project**. |
| **Restore source** | Reconnect a missing original WAV, or explicitly replace it as described below. |
| **Delete** followed by the track title | Open a confirmation dialog. **Delete project** removes the project, its album links and unshared source/recovery audio after storage confirms deletion. |

To recover missing audio, select **Restore source**, then **Choose source WAV**. An exact reconstructed-audio match keeps all settings; the filename alone does not establish a match. For different audio, or an older project without verifiable source identity, Aurialis asks you to select **Replace source** explicitly. Replacement keeps the project and album links, adjusts settings for the new sample rate, and clears source-derived results. Any available earlier source audio is kept as a recovery copy until the project is deleted; already missing audio cannot be recovered from browser storage.

## Measure the original in Deep

In **Deep**, select **Analyze original audio** under **Measured source analysis**. It measures the stored source's frequency-band energy and intervals where energy, tone or stereo width changes. Use **Cancel analysis** to stop it.

Results use neutral interval names; a change-strength percentage is a heuristic score, not the probability of a verse or chorus. The analysis does not generate mastering moves or change your settings. The separate **Apply profile** action applies a static preset throughout the track.

## Review and apply a Deep proposal

1. Open **Deep**, choose a **Deep engineer profile**, then select **Analyze Deep proposal**. This measures the original source and leaves the current sound unchanged. If a draft already exists, **Keep draft** or Escape preserves every edit; confirm replacement only when you want a new proposal. **Cancel Deep analysis** stops the request.
2. Review the neutral sections, findings and proposed moves. They are heuristic suggestions, not detected verses/choruses or a trained mastering engineer. Select a timeline move to edit its labeled source-frame points, values, operation and fade; add, delete or reset moves as needed. These are draft edits.
3. Select **Apply Deep proposal** to publish the complete baseline and schedule together. Wait for acknowledgment. Until then, playback and export retain the previously accepted settings. **Mute draft move** and **Solo in proposal** stay silent until Apply; **Apply solo proposal** uses that filtered snapshot in both playback and export.
4. Listen and export. Later Advanced edits prepare a complete replacement revision using the applied moves; draft edits are separate. If preparation fails, use the displayed retry or restore-applied-settings action. Do not assume pending values have been exported.
5. Use **Revert before first Apply** to restore the complete settings saved before the first Apply, or **Detach automation** to keep the applied static baseline without its moves. Both retain the draft. Detach before choosing a static Simple direction, applying Reference changes or setting target loudness. The album-consistency branch preserves applied Deep processing by adding a separate gain stage after its complete chain.

Keep the original audio separately. Draft/applied **Script JSON** downloads provide complete recovery copies when browser storage fails; the app currently has no Script JSON import workflow. A different source cannot reuse an applied schedule. Use Library's exact **Restore source** workflow for missing audio; explicit replacement invalidates source-bound analysis and automation.

Deep currently uses algorithm 1, generic Optical compression and sample-peak limiting. It does not provide AI repair, musical-role recognition, certified true-peak limiting or Waves/hardware equivalence. Finite playback drains its full valid delayed output. Turning Repeat on after finite input ends preserves that pass before a new prepared epoch, so a brief gap is possible.

## Review the WAV you will hand off

Open **Release check** from **Tools** for your project.

1. Choose **Spotify**, **Apple Music**, **YouTube**, **SoundCloud**, **CD** or **Podcast**, then choose 16-bit PCM, 24-bit PCM or 32-bit float. Profiles describe different delivery scopes; read the linked source and the explanation beside each check.
2. Select **Run release check**. Aurialis verifies the stored source, renders one WAV, then measures that encoded file, including quantization and dither. With Deep attached, it uses the acknowledged applied script; draft edits are excluded. **Cancel release check** stops the review without accepting a late result.
3. Review loudness, reconstructed peak estimate, exact encoded full-scale frames, format, correlation, leading/trailing quiet and DC. The “within guidance” count excludes informational items and is not a readiness percentage. The check applies no gain, trimming, resampling or repair.
4. Select **Download measured WAV** to save the exact file that was reviewed. Repeated downloads reuse that file. **Download JSON report** includes measurements, the output SHA-256, the selected policy source and its limits.
5. Use **Save report to project** to retain its measurements. After reloading, the saved report can supply JSON only; run the review again to obtain a measured WAV. Keep downloaded audio and reports in your own backup.

Source, settings or encoding changes invalidate the current review. Choosing another destination reuses its measurements and updates the guidance without rendering again. Missing or unverifiable audio requires **Restore source** in Library before review. A different source cannot inherit the old report.

Spotify and SoundCloud profiles use published mastering guidance, not upload loudness requirements; their ±1 LU review band is an Aurialis preference. Apple Music checks source PCM format rather than Digital Masters approval. YouTube covers the cited music-video Content ID partner guidance, and a WAV alone is not a video delivery. CD checks 44.1 kHz / 16-bit stereo PCM, not disc-image or manufacturing approval. Podcast covers Apple subscriber WAV and pre-encoding guidance; RSS delivery still needs AAC or MP3. Profiles do not certify codec/converter peaks, source provenance or metadata. The clean WAV contains no artist, album, artwork or ISRC tags.

## Compare with a reference recording

Import the recording you want to use as a reference, then open **Reference match** from **Tools** for your source project.

1. Choose a **Reference track**. Aurialis compares your source through this session's starting processing settings with the original reference audio. The reference project's saved knob positions are ignored.
2. Choose **Match amount**. Leave **Protect low end** on to constrain changes in the 20–120 Hz range; enable **Include width** only if you want a stereo-width proposal too.
3. Select **Analyze reference audio**. This leaves your settings unchanged. Both sources must be available and have verified identities; use Library's **Restore source** for older or missing sources when prompted.
4. Review the measured band averages, proposed EQ changes, residual mismatch and warnings. These describe a broad tonal comparison, not a guarantee that the two recordings will sound alike.
5. Select **Apply measured proposal** when you want those settings. Repeated Apply and amount changes use the session's original baseline, so they do not stack corrections. Choose **Back to master** to listen or export.

**Revert Reference** restores the settings from before this Reference session while its applied settings remain current. This is a temporary, session-specific undo: leaving Reference or making other processing/source changes ends that protection. For a lasting alternative, use **Duplicate settings** in Library before experimenting.

Changing the reference or matching options requires fresh analysis before Apply. There is no hidden gain adjustment or automatic loudness matching; check final loudness and peak headroom separately. Both audio sources share the **129 MiB multipart request ceiling**, so two individually supported files may still be too large together. See the [measured Reference API contract](api.md#measured-reference-proposals) for its exact bounds.

## Playback and keyboard shortcuts

Tap **Restart track** to return to the beginning. The forward control opens the next Library track when one is available; otherwise it skips ahead ten seconds. Hold either control to scrub through the track. **Repeat track** loops the current track.

| When focused on… | Shortcut |
| --- | --- |
| The waveform | Left/Right seeks one second; Shift seeks ten seconds; Alt seeks a tenth of a second. Home returns to the start; End goes to the end. |
| A mastering slider | Arrow keys adjust its value. Backspace or double-click resets it to its default. |
| An EQ point | Left/Right changes frequency; Up/Down changes gain for filters other than high-pass. Backspace or double-click resets its frequency and gain. |
| A dialog | Escape closes it. |

## Where your work lives

Audio processing uses the browser and your local Go server. The standard app does not require a cloud audio service or an account. Build-time dependency downloads are separate from audio processing.

Reconstructed audio lives in **IndexedDB**, the browser's local database. Project settings and album metadata live in **localStorage**, another browser storage area. Use the same browser profile and local address to return to that workspace. Changing the host or port uses a different browser storage location.

Browser storage is not a backup: clearing site data, switching profiles, or storage failure can make your work unavailable. Library shows storage estimates when available and offers **Request persistent storage**; the browser may decline it, and permission does not replace a backup.

If Aurialis warns that audio is available only in this tab, export before closing or reloading. Session-only audio survives navigation inside Aurialis, with a total cache cap of **128 MiB plus 44 bytes**; further imports fail when it fills. Use **Restore source** to reconnect a missing source from your original file.

## If something gets stuck

| What you see | What to try |
| --- | --- |
| The local page will not open | Check that `./aurialis` is still running and use the address it is serving. See [startup and configuration](development.md). |
| “Failed to fetch” or a local-server connection error | Confirm the local server is running at the page's address, then retry. The message alone does not establish why the connection failed. |
| The server is busy | Let the current import or render finish, or cancel it, then retry. One expensive audio request is admitted at a time. |
| Import rejects the file | Check its format, channel count, size and duration against step 1. Renaming a compressed file to `.wav` does not convert it. |
| “The source audio is missing” | Use **Retry source** if offered, then **Restore source** to reconnect the original WAV without creating a new project. |
| Playback initialization fails | Select **Retry playback** when shown, then Play. A current Chromium-based browser is a useful starting point; recorded Chromium/Brave results do not establish support for every browser or device. |
| The requested loudness cannot be reached | Choose a less demanding target or change processing, then run **Set target loudness** again. |
| An album exceeds its download cache | Render a smaller sequence or export its tracks individually. |
| Reference analysis needs verified source identity | Restore the source WAV through Library. Older or different audio requires explicit **Replace source** and invalidates source-derived results. |
| A Reference proposal is stale | Analyze again after source, reference, options or processing changes; your newer settings are preserved. |
| A saved Release report has no WAV download | Run the release check again. Saved reports contain measurements, not a persistent audio artifact. |
| A Release review disappears after an edit | Source, processing or encoding changed. Run it again for the new output; canceled or stale results cannot replace that output. |

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
