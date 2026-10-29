# Your first master
<!-- cspell:words ISRC -->

Bring in a WAV, find a direction you like, and download a new version. Your first session can stay entirely in **Simple** mode.

Open **[aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/)** (or [aurialis.yosef.app](https://aurialis.yosef.app/)) in a current browser. There is nothing to install or sign in to: audio is processed on your device with WebAssembly and never uploaded. Running the native build you compiled from source instead? See [the native build appendix](#appendix-the-native-build) for the differences.

## 1. Bring in a track

On **Home**, drop audio files onto the import area, paste audio files from the clipboard, or select **Choose audio**. The library starts empty; there are no bundled songs.

Use a mono or stereo WAV, AIFF, FLAC or MP3 at **8–192 kHz**. WAV and AIFF can be 8/16/24/32-bit integer PCM or 32-bit float, including the extensible WAV header most DAWs write for 24-bit and high-rate files. Mono is converted to stereo. OGG, M4A, AAC and compressed AIFF-C need conversion first.

Aurialis imports selected files one at a time. It validates each file on your device (in a browser Web Worker, or through the native build's local server), rebuilds its audio into a clean stereo-float WAV, prepares a waveform, and saves that reconstructed source in this browser. Invalid files are skipped with a reason. Select **Cancel import** to stop the queue; already imported projects remain in your Library. Keep your original files separately: the stored versions do not retain the original container metadata.

The file cap is **256 MiB plus a 44-byte WAV header**, with at most **33,554,432 decoded frames**. That is about **11 min 39 s at 48 kHz**, **12 min 40 s at 44.1 kHz**, or **5 min 49 s at 96 kHz**; the file-size limit may shorten this. In the browser, memory admission may reject long tracks sooner on phones, 4 GB devices, and desktop Safari or Firefox (about 9½ minutes at 48 kHz there). Longer recordings need a shorter selection or a lower sample rate before import. Lowering bit depth alone does not increase the frame limit.

When import finishes, the first successfully imported track opens in the mastering workspace in **Advanced** mode. Other imported projects are in **Library**. Select **Simple** to follow the next steps.

## 2. Find the feeling

Choose a **Genre**, a **Tone intention**, a **Mastering style**, and an **Intensity**. These are original creative starting points, not song analysis. **Precise** keeps a restrained curve; **Organic** eases compression and color. **Elevated** measures the complete candidate against peak and loudness upper bounds before accepting it, without adding automatic gain. If it rejects a candidate, your current sound stays in place; reduce **Input gain** in Advanced and retry, or choose another style.

**Depth** and **Presence** add optional low-frequency and upper-frequency contours. They combine once in either order. Metal and Jazz are also available as genre starting points.

Use **Play**, then compare **A Processed** with **B Original**. What you hear as A is what you export: live playback renders the same processing as the WAV download, including its lookahead true-peak limiter, at your source's sample rate (up to 48 kHz), and its level and true-peak meters read that audio. An 88.2 or 176.4 kHz source plays live at 44.1 kHz, and a 96 or 192 kHz source at 48 kHz, to stay within Aurialis's live CPU budget; the export keeps the source's rate. If your browser can't play the rate at all, playback uses your device's rate. In both cases a note under the transport says live A may differ slightly from the export (about 0.2 LU), and **Audition export** appears beside it: it renders the exact file **Export** would write, at the format chosen in the Export dialog, and plays it. Rendering shows its progress and can be canceled. Change any setting afterwards and the audition stops and says it no longer matches the export; select **Re-render audition** to hear the current version. Live playback and the audition pause each other, and your keyboard or headset play/pause key controls whichever one you started last. The audition follows the **Playback volume** slider. It is the exact export, so **Equal-loudness A/B** does not apply to it. If you then export at the same format, Export saves the file you just auditioned instead of rendering it again. The limiter looks about 2.5 ms ahead; A and B are both delayed by that amount, so they follow the same playback position and switching between them is never offset. A is selected by default. A louder version can seem more impressive even when its tone is less useful, so turn on **Equal-loudness A/B** beside A/B to compare at equal loudness. Aurialis measures the integrated loudness of the source and of exactly what you hear for A, then lowers whichever of A or B is louder by that one fixed amount; it never boosts either side and does not ride the level while you listen. The line next to the toggle shows the offset, for example "B −4.2 dB to match A", and screen readers announce it. After you change a setting it keeps the previous offset and reads "Re-measuring (holding B −4.2 dB)" until the new measurement arrives. Equal-loudness A/B only changes what you hear, as its note says: exports are identical with it on or off, and the level meters show A or B before the offset. In the browser version, Export and Deep analysis take priority over the measurement, which resumes afterwards. Your choice is remembered in this browser, not saved in the project.

The transport can also monitor **Mono** or **Side** without changing the delivered file. Mono is `(L+R)/2` in both ears; Side is `(L−R)/2` in both ears. This browser-local listening preference changes the local peak, RMS and correlation readings; live LUFS and true peak continue to describe processed stereo delivery. Audition export and downloaded WAV remain stereo.

Simple and Advanced share one set of processing settings. Switching tabs preserves your sound. Choosing a new genre, tone, style, modifier or intensity replaces other custom Advanced edits while retaining explicit **Input gain** and the selected loudness/ceiling. Manual edits clear active direction badges and remember the last style/modifiers. Zero intensity removes direction shaping while retaining explicit gain and limiter targets.

## 3. Set the level, if you need to

Choose an **Output target**, then select **Set target loudness**. Aurialis measures the current chain and adjusts its input gain toward the requested average loudness, then reports the level the export measures. Press **Play** to hear it: live playback already runs the export chain, so there is no separate preview to render. If the target cannot be reached within the supported processing and peak limits, it reports an error.

Every target uses a −1 dBTP ceiling (Streaming −14, Loud −9, Dynamic and Podcast −16 LUFS), and −1 is the highest ceiling Advanced offers. A saved project with a higher ceiling is lowered to −1 when it loads, with a note you can dismiss; run Set target loudness or export again to re-measure. Selecting a target alone does not measure or normalize the whole track. If you change processing afterward, run **Set target loudness** again when you want a fresh measurement. Targets are working preferences, not a promise that a streaming service will accept or preserve that level.

Albums can optionally build a separate **continuous WAV** for gapless playback, a 0–5 second gap, or a 0.1–5 second linear crossfade. This does not change the individual track masters. Build the file first, then use its preview or download controls; preview does not start automatically.

## 4. Export a WAV

Select **Export**, choose a bit depth, a sample rate and, for 16/24-bit PCM, dither. Then select **Render & download WAV**. In Advanced settings, **Render quality** is saved per project: Classic preserves the established algorithm; Oversampled uses 2× processing for saturation and requires more processing. Its designed 129-tap half-band FIR filters together add 64 base-rate frames of fixed latency. This improves rejection but is not an alias-free guarantee. Playback, exports and applied Deep processing follow the selected quality.

| Choice | What it saves |
| --- | --- |
| **24-bit PCM** | The default integer WAV export. |
| **16-bit PCM** | A lower-bit-depth integer WAV. |
| **32-bit Float** | A float WAV that can retain audio above integer full scale. |

| Choice | What it does |
| --- | --- |
| **Sample rate** | The source rate (marked *source*) keeps every frame. 44.1, 48, 88.2 or 96 kHz converts after mastering and keeps the duration. With the limiter on, the converted audio is limited again to the true-peak ceiling at the new rate. A converted export may not exceed 33,554,432 frames (about 5:49 at 96 kHz). Rates that would exceed it, or that the source rate cannot convert to, are disabled and the dialog says why. |
| **Dither** | **TPDF** (default) or **Off** for 16/24-bit PCM. Turn it off only for material that is already dithered. 32-bit Float is never dithered. |

After export, the status line shows the delivered true peak at the delivery rate. It is measured on a near-ideal reconstruction and reads ≤ 0.1 dB on all content except sustained coherent energy within about fs/16384 of Nyquist, which is unphysical in real audio and removed by the guard in limited exports. It is a guide, not a certification. Integer exports clip samples outside ±1; enable the limiter or reduce gain before exporting a signal that exceeds that range.

Export renders the current processing settings from the reconstructed source. With Deep attached, the acknowledged applied script is authoritative; draft edits and pending revisions are excluded. Listening to **B Original** or changing monitor volume does not change those export settings. The download is a separate file; keep it and your original source in your own backup.

## Go further when you are ready

| In the app | Use it for |
| --- | --- |
| **Advanced** | Adjust input gain, five-band EQ, compression, saturation, stereo width, a true-peak limiter, De-Harsh and three-band compression. These controls change the shared chain used by Simple and export. |
| **Deep** | Analyze a measured proposal, edit source-frame moves and explicitly Apply its complete baseline/schedule. Separate source diagnostics remain available. Neutral sections do not identify musical roles; AI repair remains unavailable. |
| **Albums** | Create and order a sequence, choose its level and **Delivery format**, then select **Render album masters** to render and measure one WAV per song. Rendering never changes your projects. |
| **Reference match** on a project's Master view or in **Tools** | Measure your track against another imported recording, review a bounded EQ and optional width proposal, then explicitly apply it. |
| **Release check** on a project's Master view or in **Tools** | Choose one of six destination profiles and a delivery format, then review the exact WAV Export renders at that format. Download that measured file and its JSON report; saved reports retain measurements only. This is guidance, not platform certification. |
| **Smart stem splitter** | In the native build, split a song into 2–6 stems, play each one and download it as `<title> - <Stem>.wav`. Open it from a project's Master view or from **Tools**. In the browser, Master and Tools state that it is unavailable instead of linking to it. See the status below. |

**Smart Split status:** Smart Split runs only in the native Aurialis build, which you build from source; the browser build cannot separate stems. It needs the macOS build, which uses Apple Accelerate: on an idle Apple-silicon Mac (8-core M2) one 20-second window took about 32 seconds, so a four-minute song would take roughly 14 minutes, but no idle full-song timing has been recorded, and a busy machine took up to about three minutes per window. On Linux and Windows Smart Split is turned off: plain Go did not finish one 20-second window in 30 minutes, so a song could not finish within the 90-minute job limit.

On the Split page, the note under the stem layout says where the model stands:

| Note | Meaning |
| --- | --- |
| The first split downloads the 176 MB separation model once. | No model on this computer yet. |
| Downloading the separation model: … | A split is downloading it now, with the bytes so far. |
| The separation model is saved on this computer and verified. The first split loads it; nothing to download. | A model downloaded earlier passed its size and SHA-256 check; the first split after a restart loads it from disk. |
| The saved separation model failed its check. … | The cached file is damaged or incomplete; the first split deletes it and downloads a fresh copy. |
| The separation model is ready. | The model is in memory; splits start at once. |
| Smart Split is off in this build: it runs the model in plain Go … | A Linux, Windows or `CGO_ENABLED=0` build. Split stays disabled. |

On the macOS build the page also estimates the selected song, for example "Estimated split time for this 3:45 song: about 13 minutes (25 model windows …)", with the busy-machine figure and a warning when that would pass the 90-minute job limit. The figures were recorded on one 8-core M2 Mac, not measured on yours.

An album's **Level** defaults to **Keep each master’s level**: each WAV matches that track's own export, including an applied Deep script. Choose **Normalize to a target** to render every track at the selected target (−23 to −9 LUFS) plus its own album offset (±6 LU), shown as "Renders at … LUFS". The level and offsets are saved on the album, not in the projects. Normalizing needs Deep automation detached in that master. After rendering, the album shows each WAV's measured loudness and true peak. No chart is shown until the masters have been rendered and measured. Projects included in an album render before this version still carry the input gain that render wrote into them, and the library labels them **Album render LUFS**; open each in Master and check its input gain.

An album's **Delivery format** uses the same bit depth, sample rate and dither choices as **Export**, and every master is the file Export would render at that format. The default is 24-bit PCM at each source's own rate. It has its own **Album delivery format** panel. When the sequence mixes source rates, the panel names them; choose one sample rate to make every master the same format, or select **Use CD format: 44.1 kHz, 16-bit** to set both for CD. A rate that any song cannot be converted to is unavailable, with the reason shown. If a song added later cannot reach the saved rate, the album status names it and masters render at each source rate until you remove it or choose another rate. With **Keep each master’s level**, each WAV equals that song's single export at the album format.

Rendered album masters are saved in your browser and survive reloads. Download each WAV, or choose **Download all as ZIP** for one numbered archive in running order. Changing the sequence, processing settings, album level or delivery format makes saved masters stale; render again to replace them. Masters saved before the delivery format was selectable stay current at the default format (each source rate, 24-bit, TPDF dither). Before rendering, Aurialis checks that the browser has room for every master. Without browser storage, masters use a **128 MiB in-memory cache** and are lost when you leave the album page. **Delete album** removes the album and its saved masters but keeps your projects. Album rendering does not establish full album-consistency mastering.

## Keep your Library organized

Use **Search your library**, status filters and **Sort projects** to find a project. Each row's action button opens its project actions:

| Action | What it does |
| --- | --- |
| **Preview** followed by the track title | Listen with that project's processing settings and A/B controls without opening Master. |
| **Duplicate settings** | Create an independent project and stored source copy for another direction. Restore a missing source before duplicating. |
| **Add to album** | Add the project to an existing album or create one with **New album with this project**. |
| **Restore source** | Reconnect a missing original WAV, or explicitly replace it as described below. |
| **Delete** followed by the track title | Open a confirmation dialog. **Delete project** removes the project, its album links and unshared source/recovery audio after storage confirms deletion. |

To recover saved sources from the previous Aurialis, open **Library** and select **Find old projects**. Recover selected WAV, AIFF, FLAC or MP3 files as new projects with default settings; the old audio, scripts and settings remain in their original storage. Each saved original is limited to 128 MiB, with additional decoded-frame and browser-memory limits. Unsupported OGG, AAC and M4A originals remain stored. Recovery is isolated by browser profile and site address; see the [legacy recovery guide](legacy-library.md) before clearing site data. This is separate from restoring a missing source in a current project.

To recover missing audio, select **Restore source**, then **Choose source WAV**. An exact reconstructed-audio match keeps all settings; the filename alone does not establish a match. For different audio, or an older project without verifiable source identity, Aurialis asks you to select **Replace source** explicitly. Replacement keeps the project and album links, adjusts settings for the new sample rate, and clears source-derived results. Any available earlier source audio is kept as a recovery copy until the project is deleted; already missing audio cannot be recovered from browser storage.

## Measure the original in Deep

In **Deep**, select **Analyze original audio** under **Measured source analysis**. It measures the stored source's frequency-band energy and intervals where energy, tone or stereo width changes. Use **Cancel analysis** to stop it.

Results use neutral interval names; a change-strength percentage is a heuristic score, not the probability of a verse or chorus. The analysis does not generate mastering moves or change your settings. The separate **Apply profile** action applies a static preset throughout the track.

## Review and apply a Deep proposal

1. Open **Deep**, choose a **Deep engineer profile**, then select **Analyze Deep proposal**. This measures the original source and leaves the current sound unchanged. If a draft already exists, **Keep draft** or Escape preserves every edit; confirm replacement only when you want a new proposal. **Cancel Deep analysis** stops the request.
2. Review **What Apply changes** (every setting that differs from your current settings) and **Predicted export levels**: loudness, true peak and crest measured by rendering the draft through the export limiter. Proposals add no makeup gain, so they are often quieter; after Apply, turn on **Equal-loudness A/B** on the transport to compare at equal loudness, or use Set target loudness. A finding explains any rise above 1 LU, drop above 1 LU or crest cut above 4 dB. Editing a move marks the prediction as out of date. Then review the neutral sections, findings and proposed moves. They are heuristic suggestions, not detected verses/choruses or a trained mastering engineer. Select a timeline move to edit its labeled source-frame points, values, operation and fade; add, delete or reset moves as needed. These are draft edits.
3. Select **Apply Deep proposal** to publish the complete baseline and schedule together. Wait for acknowledgment. Until then, playback and export retain the previously accepted settings. **Mute draft move** and **Solo in proposal** stay silent until Apply; **Apply solo proposal** uses that filtered snapshot in both playback and export.
4. Listen and export. Later Advanced edits prepare a complete replacement revision using the applied moves; draft edits are separate. If preparation fails, use the displayed retry or restore-applied-settings action. Do not assume pending values have been exported.
5. Use **Revert before first Apply** to restore the complete settings saved before the first Apply, or **Detach automation** to keep the applied static baseline without its moves. Both retain the draft. Detach before choosing a static Simple direction, applying Reference changes, setting target loudness or normalizing an album.

Keep the original audio separately. Draft/applied **Script JSON** downloads provide complete recovery copies when browser storage fails; the app currently has no Script JSON import workflow. A different source cannot reuse an applied schedule. Use Library's exact **Restore source** workflow for missing audio; explicit replacement invalidates source-bound analysis and automation.

Deep plays and exports an applied script through the export's lookahead true-peak limiter and generic Optical compression. It does not provide AI repair, musical-role recognition, certified true-peak limiting or Waves/hardware equivalence. Finite playback drains its full valid delayed output. Turning Repeat on after finite input ends preserves that pass before a new prepared epoch, so a brief gap is possible.

## Review the WAV you will hand off

Open **Release check** from the tool links below your project's title on its Master view. In **Tools**, choose the project in **Track** first; it starts on your newest import and remembers your choice while the tab stays open.

1. Choose **Spotify**, **Apple Music**, **YouTube**, **SoundCloud**, **CD** or **Podcast**, then the **Delivery format**: bit depth, sample rate and, for 16/24-bit PCM, dither. These are the Export choices, and the line below them names the file that will be checked. With **CD** selected, **Use CD format: 44.1 kHz, 16-bit** sets both. Profiles describe different delivery scopes; read the linked source and the explanation beside each check.
2. Select **Run release check**. Aurialis verifies the stored source, renders the WAV Export delivers at that format (converting the rate and dithering once at the new rate when you choose another rate), then measures that encoded file, including quantization and dither. With Deep attached, it uses the acknowledged applied script; draft edits are excluded. **Cancel release check** stops the review without accepting a late result.
3. Review loudness, reconstructed peak estimate, exact encoded full-scale frames, format, correlation, leading/trailing quiet and DC. The “within guidance” count excludes informational items and is not a readiness percentage. The check applies no gain, trimming or repair, and resamples only to the sample rate you chose.
4. Select **Download measured WAV** to save the exact file that was reviewed. Repeated downloads reuse that file. **Download JSON report** includes measurements, the output SHA-256, the selected policy source and its limits.
5. Use **Save report to project** to retain its measurements. After reloading, the saved report can supply JSON only; run the review again to obtain a measured WAV. Keep downloaded audio and reports in your own backup.

Source, settings or delivery format changes (bit depth, sample rate or dither) invalidate the current review. Choosing another destination reuses its measurements and updates the guidance without rendering again. Missing or unverifiable audio requires **Restore source** in Library before review. A different source cannot inherit the old report.

Spotify and SoundCloud profiles use published mastering guidance, not upload loudness requirements; their ±1 LU review band is an Aurialis preference. For a master louder than −14 LUFS, Spotify and SoundCloud publish −2 dBTP of headroom; Apple Music and YouTube are lossy streaming too, so Aurialis asks for the same −2 dBTP there as its own guidance, because loud masters can overshoot after lossy encoding. Peak headroom uses inclusive limits: exactly −1.00 dBTP passes the normal threshold, and exactly −2.00 dBTP passes for a master louder than −14 LUFS. These are Aurialis checks, not platform certification. Apple Music checks source PCM format rather than Digital Masters approval; a delivery above the source rate reads **Review** with “upsampled from” beside the format, because Apple discourages upsampled masters. YouTube covers the cited music-video Content ID partner guidance, and a WAV alone is not a video delivery. CD checks 44.1 kHz / 16-bit stereo PCM, not disc-image or manufacturing approval; choose that format to check the converted file. Podcast covers Apple subscriber WAV and pre-encoding guidance; RSS delivery still needs AAC or MP3. Profiles do not certify codec/converter peaks, source provenance or metadata. The clean WAV contains no artist, album, artwork or ISRC tags.

## Compare with a reference recording

Import the recording you want to use as a reference, then open **Reference match** from the tool links on your source project's Master view, or choose the source project in **Tools** → **Track**.

1. Choose a **Reference track**. Aurialis compares your source through this session's starting processing settings with the original reference audio. The reference project's saved knob positions are ignored.
2. Choose **Match amount**. Leave **Protect low end** on to constrain changes in the 20–120 Hz range; enable **Include width** only if you want a stereo-width proposal too.
3. Select **Analyze reference audio**. This leaves your settings unchanged. Both sources must be available and have verified identities; use Library's **Restore source** for older or missing sources when prompted.
4. Review the measured band averages, proposed EQ changes, residual mismatch and warnings. These describe a broad tonal comparison, not a guarantee that the two recordings will sound alike.
5. Select **Apply measured proposal** when you want those settings. Repeated Apply and amount changes use the session's original baseline, so they do not stack corrections. Choose **Back to master** to listen or export.

**Revert Reference** restores the settings from before this Reference session while its applied settings remain current. This is a temporary, session-specific undo: leaving Reference or making other processing/source changes ends that protection. For a lasting alternative, use **Duplicate settings** in Library before experimenting.

Changing the reference or matching options requires fresh analysis before Apply. There is no hidden gain adjustment or automatic loudness matching; check final loudness and peak headroom separately. Both audio sources share the **257 MiB multipart request ceiling**, so two individually supported files may still be too large together. See the [measured Reference API contract](api.md#measured-reference-proposals) for its exact bounds.

## Playback and keyboard shortcuts

Tap **Restart track** to return to the beginning. The forward control opens the next Library track when one is available; otherwise it skips ahead ten seconds. Hold either control to scrub through the track. **Repeat track** loops the current track.

| When focused on… | Shortcut |
| --- | --- |
| The waveform | Left/Right seeks one second; Shift seeks ten seconds; Alt seeks a tenth of a second. Home returns to the start; End goes to the end. |
| A mastering slider | Arrow keys adjust its value. Backspace or double-click resets it to its default. |
| An EQ point | Left/Right changes frequency; Up/Down changes gain for filters other than high-pass. Backspace or double-click resets its frequency and gain. |
| A dialog | Escape closes it. |

## Where your work lives

Audio processing happens on your device: in the browser build, Go/WebAssembly workers in this tab do all the work and nothing is uploaded. The site serves only the app and its audio-engine files, and needs no account.

Reconstructed audio lives in **IndexedDB**, the browser's local database. Project settings and album metadata live in **localStorage**, another browser storage area. Use the same browser profile and address to return to that workspace. A different address (the other public domain, or the native build's local address and port) uses a different browser storage location.

Browser storage is not a backup: clearing site data, switching profiles, or storage failure can make your work unavailable. Library shows storage estimates when available and offers **Request persistent storage**; the browser may decline it, and permission does not replace a backup.

If Aurialis warns that audio is available only in this tab, export before closing or reloading. Session-only audio survives navigation inside Aurialis, with a total cache cap of **256 MiB plus 44 bytes**; further imports fail when it fills. Use **Restore source** to reconnect a missing source from your original file.

## If something gets stuck

| What you see | What to try |
| --- | --- |
| Audio processing is busy | Let the current import or render finish, or cancel it, then retry. One expensive audio job runs at a time, with at most one waiting. |
| A file exceeds the browser's memory budget | Try a shorter selection or a lower sample rate, close other heavy tabs, or use [the native build](#appendix-the-native-build). Aurialis never uploads or silently shortens a rejected file. |
| Import rejects the file | Check its format, channel count, size and duration against step 1. Renaming a compressed file to `.wav` does not convert it. |
| “The source audio is missing” | Use **Retry source** if offered, then **Restore source** to reconnect the original WAV without creating a new project. |
| “Playback can't keep up on this device” | Turn off some processing modules, or close other busy apps or tabs, then press Play. Export is unaffected. |
| “Live playback lost its processed audio” | An internal buffer fault, not a CPU limit. Press Play to restart, and reload the page if it happens again. |
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
| **Limiter / ceiling** | Restricts peaks toward a chosen maximum. Live playback and export use a lookahead limiter that holds the reconstructed (inter-sample) peak under the ceiling. With the limiter on, the audio is band-limited, flat to 0.45 × the sample rate (19.85 kHz at 44.1 kHz), so true peaks stay under the ceiling. The filter is minimum-phase: it shifts the top octave's phase (about 1 ms of delay near 19.8 kHz at 44.1 kHz, under 0.04 ms below 15 kHz), so a limited master won't null against the source even at unity gain. Hard-clipped sources now get about 0.25 dB or more extra limiting than before, because earlier exports let their true peaks over the ceiling. The live **True peak** tile is a display estimate and can read low on unlimited content near the top of the band; the export check (the export report and Release Check) is authoritative and reads within 0.1 dB. |
| **LUFS** | A measure of perceived loudness over time. A less negative reading generally means a louder signal. |
| **dBFS** | Level relative to digital full scale. For integer PCM, 0 dBFS is the maximum sample level. |
| **Sample rate** | Samples per second; 48 kHz means 48,000 samples per second per channel. |
| **Bit depth** | How sample values are represented. Float WAV can preserve headroom beyond the integer PCM range. |
| **DSP / WASM** | Digital signal processing is the audio math. WebAssembly lets the Go processing engine run in the browser. |

## Appendix: the native build

The native single binary is a fallback you build from source; no prebuilt binaries are published. Follow [the README build steps](../README.md#build-the-native-fallback-from-source), keep `./aurialis` running while you work, and open the address it prints (by default `http://127.0.0.1:8080`). It uses the same interface and the same Go processing, served by its own local server, and it is the only build that runs Smart Split.

| What you see | What to try |
| --- | --- |
| The local page will not open | Check that `./aurialis` is still running and use the address it is serving. See [startup and configuration](development.md). |
| “Failed to fetch” or a local-server connection error | Confirm the local server is running at the page's address, then retry. The message alone does not establish why the connection failed. |
| The server is busy | Let the current import or render finish, or cancel it, then retry. One expensive audio request is admitted at a time. |
| Smart Split says the model could not be downloaded | The first split downloads the 176 MB model from the `stem-model-v1` release; check your internet connection and split again to retry. |

[Back to the README](../README.md) · [All documentation](README.md) · [Processing architecture](architecture.md)
