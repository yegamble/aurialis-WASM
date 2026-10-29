# Recovering sources from the previous Aurialis

The previous app may have saved original audio in this browser. The replacement can recover selected WAV, AIFF, FLAC and MP3 sources as new projects while keeping the old audio and settings.

Use the same **browser profile and site address** that you used before. Different addresses, including `aurialis.yosefgamble.com` and `aurialis.yosef.app`, have separate storage. Do not clear site data while recovery is incomplete.

## Recovering a saved source

1. Open **Library** and select **Find old projects**. Discovery starts only after this action.
2. Review the source names and sizes. A page contains at most 32 eligible source files; select **Next saved files** to continue.
3. Select **Recover audio source** for one original. Aurialis validates the actual WAV, AIFF, FLAC or MP3 data through the current device-local Go decoder and reconstruction path. FLAC and MP3 are decoded to clean PCM; recovery does not copy their compressed container into the new project.
4. Wait for successful recovery, then select **Close**. A new Library project contains the reconstructed source, fresh measurements and default mastering settings. Open it to review the audio and choose settings.

The old original, project settings and scripts remain in their existing storage. Recovery does not apply or translate old DSP settings. Recovered audio is clean PCM, rather than a byte-for-byte backup of the original container.

The current source limits are 256 MiB plus the canonical header and 33,554,432 frames; recovering an old original still accepts at most 128 MiB plus the header, the limit those originals were imported under. A browser's conservative memory admission can reject smaller files when retained audio or processing would exceed its budget. Recovery requires durable browser storage; it does not substitute a session-only copy for a successful recovery.

## When recovery cannot continue

**Unsupported original:** this recovery screen supports WAV, AIFF, FLAC and MP3. OGG, AAC and M4A originals remain in old storage and cannot be recovered through this screen. Recovery does not provide a raw-original download. Keep the previous app’s storage and rollback resources until the overall migration is accepted.

**Missing or changed source:** the selected storage key or browser file may no longer match. Scan again after closing other Aurialis tabs. Recovery never removes an old record to repair this condition.

**Storage denied or full:** allow browser storage or free space outside the old Aurialis library, then retry. A failed save does not publish a new project.

**Canceled operation:** select **Cancel recovery** or close the dialog. The old original remains. If a new copy was already staged, recovery removes only that new copy after its storage operation settles. Browser file operations have no preemption API; another file read is refused until a pending one actually settles. Reload if the browser stops responding.

**Invalid storage keys:** discovery reads at most 64 keys per page and reports skipped keys. An oversized continuation key stops the bounded scan explicitly; more records may remain. Their stored values are not loaded or deleted.

## Storage and verification boundaries

Discovery uses key-only, read-only transactions in `aurialis-library-entries-v1/kv`. It never deserializes the previous app's metadata, scripts or preferences. Existing fingerprints supply the displayed filename and size, plus the source date used for validation. Selected files are read beneath the existing browser `library` directory using the encoded fingerprint basename and `create: false`. No old hydration, orphan cleanup or export code runs.

The selected file is checked again around saving. Key existence, file size and modification date are change checks; they do not establish a cryptographic identity for the old raw original. The reconstructed PCM receives the current engine's source hash and sample geometry. Actual container validation and reconstruction remain the shared Go engine's responsibility.

Local verification passed 475 frontend units, the full 111-case native browser regression at `f77c71e`, and fresh four-case native recovery plus the complete 12-case static browser suite at wording checkpoint `9f1c4ce`. Recovery cases exercise real CDR, default settings, exact old-data preservation, staged cancellation, changed-file rejection, six responsive widths and accessibility. Static recovery made no audio upload or download. [PR #17](https://github.com/yegamble/aurialis-WASM/pull/17) subsequently merged at `59d16f6` after all 14 exact-head jobs and GitGuardian passed, including 111 native and 12 static browser cases. The corrected app then passed all 12 hosted cases on each public domain after PR #18; [the task record](tasks.md#reference-state-and-public-domain-trial) retains exact source and deployment evidence. The current implementation accepts FLAC and MP3 recovery, but this page does not claim final product completion; the integrated recovery slice still awaits its full required gates and merge.
