# Recovering sources from the previous Aurialis

The previous app may have saved original audio in this browser. The replacement can recover selected WAVs as new projects while keeping the old audio and settings.

Use the same **browser profile and site address** that you used before. Different addresses, including `aurialis.yosefgamble.com` and `aurialis.yosef.app`, have separate storage. Do not clear site data while recovery is incomplete.

## Recovering a WAV

1. Open **Library** and select **Find old projects**. Discovery starts only after this action.
2. Review the source names and sizes. A page contains at most 32 eligible source files; select **Next saved files** to continue.
3. Select **Recover WAV source** for one original. Aurialis checks its actual WAV signature and sends the selected file through the current device-local validation and reconstruction path.
4. Wait for successful recovery, then select **Close**. A new Library project contains the reconstructed source, fresh measurements and default mastering settings. Open it to review the audio and choose settings.

The old original, project settings and scripts remain in their existing storage. Recovery does not apply or translate old DSP settings. Recovered audio is clean PCM, rather than a byte-for-byte backup of the original container.

The current source limits are 128 MiB plus the canonical header and 16,777,216 frames. A browser's conservative memory admission can reject smaller files when retained audio or processing would exceed its budget. Recovery requires durable browser storage; it does not substitute a session-only copy for a successful recovery.

## When recovery cannot continue

**Compressed original:** the previous app could retain MP3, FLAC, OGG, AAC and M4A files. This recovery screen does not convert those formats. It leaves their original bytes and records untouched. A separately qualified clean PCM recovery path is required before permanently retiring the rollback resources. Downloading a raw original through this screen is unavailable.

**Missing or changed source:** the selected storage key or browser file may no longer match. Scan again after closing other Aurialis tabs. Recovery never removes an old record to repair this condition.

**Storage denied or full:** allow browser storage or free space outside the old Aurialis library, then retry. A failed save does not publish a new project.

**Canceled operation:** select **Cancel recovery** or close the dialog. The old original remains. If a new copy was already staged, recovery removes only that new copy after its storage operation settles. Browser file operations have no preemption API; another file read is refused until a pending one actually settles. Reload if the browser stops responding.

**Invalid storage keys:** discovery reads at most 64 keys per page and reports skipped keys. An oversized continuation key stops the bounded scan explicitly; more records may remain. Their stored values are not loaded or deleted.

## Storage and verification boundaries

Discovery uses key-only, read-only transactions in `aurialis-library-entries-v1/kv`. It never deserializes the previous app's metadata, scripts or preferences. Existing fingerprints supply the displayed filename and size, plus the source date used for validation. Selected files are read beneath the existing browser `library` directory using the encoded fingerprint basename and `create: false`. No old hydration, orphan cleanup or export code runs.

The selected file is checked again around saving. Key existence, file size and modification date are change checks; they do not establish a cryptographic identity for the old raw original. The reconstructed PCM receives the current engine's source hash and sample geometry. Actual container validation and reconstruction remain the shared Go engine's responsibility.

Focused storage, header validation, controller, source-receipt and Library tests have passed locally. Actual native/static browser recovery and its accessibility, network and audio evidence are still pending. This page does not claim compressed-format recovery or completion of the whole product.
