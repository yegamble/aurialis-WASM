# Aurialis-WASM API reference
<!-- cspell:words Hann steganography -->

Current routes are implemented by `internal/server`; exact DSP structs are in `internal/audio/dsp/engine.go` and the experimental script schema is in `internal/mastering/mastering.go`. No API presence alone establishes a verified product workflow. See [tasks](tasks.md) for evidence and open requirements.

## Security and resource contract

The executable binds only to loopback IPs (default `127.0.0.1:8080`). `AURIALIS_ADDR` takes precedence over `PORT`, then `-addr`; a numeric `PORT` becomes `127.0.0.1:<port>`. The request Host must match an allowed local authority and the actual port. A supplied Origin must be HTTP with the same authority; `null` is rejected. Fetch Metadata permits only `none` or `same-origin` when supplied. Rejections return 403 JSON. These checks do not provide remote authentication.

Responses carry COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a CSP restricted to same-origin assets with hashes for the embedded bootstrap scripts. WASM uses `application/wasm`. Browser fonts are self-hosted. Permissions-Policy disables unused device access; WAV download responses also carry a sandbox CSP.

Multipart bodies are capped at **32 MiB including overhead**. `-max-upload-bytes` / `MAX_UPLOAD_BYTES_OVERRIDE` can lower this cap; larger CLI limits are rejected. Decoding permits at most **4,194,304 output frames**. Two POST uploads/renders may run concurrently; another receives **429** with `Retry-After: 1`. Worker admission also reserves input and future output memory within **256 MiB**, retains at most **64 jobs**, and returns **503 queue_full** when full. Automatic workers use at most two CPUs; explicit workers cannot exceed four. The 256 MiB budget covers admitted decoded inputs and reserved/retained WAV artifacts, not total process RSS; temporary DSP scratch is separately constrained by frame and worker limits. Worker timeout is two minutes. Terminal records and artifacts expire after 15 minutes, checked every minute.

Uploaded names are validated and never used for host disk writes. Parsing/decoding stays in bounded memory. Only mono/stereo input is supported; multichannel input is rejected. Supported inputs are WAV PCM 8/16/24/32-bit integer or 32-bit float, and 16-bit PCM AIFF. AIFC and compressed MP3/FLAC/OGG/M4A/AAC decoding are unsupported. WAV checks include declared RIFF length, alignment, byte rate, chunk bounds, duplicate chunks and whole frames. Reconstruction creates new samples without metadata. Executable/archive/script signatures are inspected in headers, metadata and outside-container trailers, not arbitrary PCM bytes. Legitimate sample bytes can match those signatures. Reconstruction is the audio-only boundary; this is not PCM steganography detection or a universal malicious-content guarantee.

Errors use JSON with `error`, `detail` and numeric `status`. Malformed fields/container/params return 400, oversized requests 413, rejected authority/origin 403, missing resources 404, admission failures 429/503, and encoding failures 500.

## Routes

Both root and `/api` aliases exist for health, render, analysis, separation and job routes.

| Method and route | Behavior |
|---|---|
| `GET /health` | 200 readiness JSON, actual embedded WASM availability, profile names and explicitly heuristic model/analysis identity. This is not a browser WASM execution test. |
| `POST /master/render` | Synchronous native DSP render from actual uploaded audio; 200 WAV or JSON. |
| `POST /analyze/deep` | 202 experimental deterministic energy/section analysis job. No trained AI/LLM inference; disabled in the product UI. |
| `POST /separate` | 202 deterministic frequency-based decomposition job for 2–6 outputs. No trained instrument separation; disabled in the product UI. |
| `GET /jobs/{id}` | 200 job snapshot; `/status` and `/result` aliases return the same snapshot. `?wait=1` waits up to four seconds while queued/running. |
| `DELETE /jobs/{id}` | Cancels queued/running work and clears terminal artifacts too; repeated cancellation of a retained record is idempotent. Missing or expired ID returns 404. |
| `GET /jobs/{id}/stems/{stemName}` | 200 WAV when an artifact exists; optional `.wav` suffix; 404 otherwise. Traversal components are rejected. |

`GET /health` reports `status: "ok"`, `service: "aurialis-wasm"`, `version: "0.1.0"`, `wasmDsp: true`, `wasmDspReady` based on embedded module presence, `gpu: false`, `models: ["deterministic-frequency-split"]`, `separationMethod: "deterministic-frequency-split"`, `analysisMethod: "deterministic-energy-heuristics"`, numeric `maxUploadBytes`/`maxDecodedFrames` and `profiles`. The readiness field does not load or execute WASM.

### Rendering

Send `multipart/form-data` with required `file` and optional fields:

- `profile`: `Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`; compatibility aliases include `indie_warmth`, `modern_pop_polish`, `pop_punk_air`, `hip_hop_low_end`, `metal_wall`.
- `params`: JSON overlay on default/profile DSP parameters. Unknown fields, nulls, trailing JSON, invalid enums, non-finite/out-of-range values and non-five-element `bands` arrays return 400. Parameters include `bypass`, `abOriginal`, `loudnessMatchAb`, `inputGainDb`, `eqEnabled`, `bands`, `compressor`, `saturation`, `stereo`, `limiter`, `repair`, `ditherBits`. Field presence does not guarantee every advertised analog topology has distinct behavior.
- `bitDepth`: `16`, `24` (default), or `32`; other values return 400. 16/24-bit PCM receives TPDF dither and clamps to integer full scale; 32-bit float decode/export preserves finite headroom above ±1. NaN and infinity are sanitized to zero. Processing can change source levels; bypassed float round-trips preserve headroom.
- `format=json`, or `Accept: application/json`: return `status`, `sampleRate`, `frames`, `duration`, `bitDepth`, `params`, `beforeMetrics`, `afterMetrics` instead of audio.

WAV output uses `Content-Type: audio/wav`, `Content-Disposition: attachment; filename="aurialis-mastered.wav"` and compatibility headers `X-Aurialis-Before-LUFS`, `X-Aurialis-After-LUFS`, `X-Aurialis-After-Peak-dBTP`. Rendering preserves the uploaded sample rate and frame count. Metric fields are `integratedLufs`, `shortTermLufs`, `truePeakDbtp`, `samplePeakDbfs`, `dynamicRangeDb`, `correlation`, `lowBassCorrelation`, `dcLeftDbfs`, `dcRightDbfs`, `clippingSamples`, `gainReductionDb`; see the measurement limitations below.

```bash
curl --fail-with-body http://127.0.0.1:8080/api/master/render \
  -F file=@source.wav -F 'params={"inputGainDb":-6}' \
  -F bitDepth=24 -o mastered.wav

curl --fail-with-body http://127.0.0.1:8080/api/master/render \
  -F file=@source.wav -F 'params={"bypass":true}' -F format=json
```

### Experimental jobs and script schema

Deep analysis accepts `file` and `profile`. Separation accepts `file` and `stems=2|3|4|5|6`, with legacy model aliases such as `htdemucs` mapping to four outputs and `htdemucs_6s` to six. These aliases do not load those trained models. Output labels are 2: Vocals/Instrumental; 3: Vocals/Drums/Other; 4: Vocals/Drums/Bass/Other; 5: Vocals/Drums/Bass/Melody/Other; 6: Vocals/Drums/Bass/Guitar/Piano/Other. Labels are heuristic, not verified isolated instruments.

A job snapshot includes `jobId` and `job_id` (same string), `kind`, `status`, `progress`, `stage`, `createdAt`, `updatedAt`; optional `profile`, `stemCount`, `error`, `detail`, `script` and `stems`. Statuses are `queued`, `running`, `done`, `cancelled`, `failed`. Queued responses do not promise finished stem descriptors. Completed stem descriptors contain `id`, `name`, `role`, `color`, `downloadUrl`, `url`, `metrics`.

The current MasteringScript schema uses **string** `version`, `profile`, `summary`, numeric `targetLufs`/`ceilingDbtp`, `sections`, `moves`, `findings`, `chainParams`, `beforeMetrics`, `afterMetrics`. Sections contain `id`, `name`, `label`, `startSec`, `endSec`, `energyDb`, `role`. Moves contain identifiers/lane/section text, `label`, `summary`, `reason`, `unit`, numeric `value`, `defaultValue`, `min`, `max`, `step`, `startSec`, `endSec`, `[time,value]` points, and booleans `muted`, `edited`. Findings contain `id`, `severity`, `title`, `detail`, `lane`. `internal/mastering/render.go` validates at most 128 moves and 256 points per move. Nonempty `points` are authoritative linear envelopes; `value` applies only when points are absent. Ten-millisecond boundary fades smooth transitions. Volume automation changes input gain without implicitly enabling compression. Script target loudness is metadata, with no hidden normalization. `RenderScriptContext` supports cancellation and validates time/value bounds. These are native-library behaviors; the UI does not provide an enabled automation workflow. This generated heuristic structure is not proof of musical section recognition, AI artifact detection or effective AI repair.

## Measurement limits and verification

Browser reporting uses sample peak dBFS, RMS and crest factor. The API meter uses BS.1770/DeMan K-weighting with 400 ms windows and 75% overlap, absolute −70 LUFS and relative −10 LU gates, and a trailing three-second short-term interval. Short clips use the available duration, which is a diagnostic approximation to standard-duration reporting. Silence reports a finite −70 LUFS floor. Offline `truePeakDbtp` uses a finite 49-tap 4× Hann-windowed sinc estimate including end padding; it is not formal certification. The streaming limiter remains sample-bounded with cubic estimation and has no validated lookahead/true-peak guarantee; the final processed sample ceiling is reapplied after level matching and dither, while original/bypass paths preserve the source. `limiter.targetLufs` is metadata only; rendering does not automatically normalize to a loudness target. Platform compliance remains unavailable. `dynamicRangeDb` is crest factor using peak and stereo-average RMS with a 1 dB floor, not EBU LRA or a standardized DR score. Correlation uses normalized cross-energy without mean subtraction; low-bass correlation filters at 110 Hz. `clippingSamples` counts frames where either channel reaches magnitude 0.9999. DC fields report the dB of the absolute channel mean. These remain diagnostic measurements. Independent comparison fixtures and limits are tracked in [architecture](architecture.md) and [tasks](tasks.md).

`pnpm run test:backend:postman` invokes the live-server Newman suite and curl probes in `tests/postman/run-newman.sh`. The current 17 requests under TS-001…TS-015 (including TS-007b and TS-008b) cover health/headers, embedded WASM and matching Go browser runtime assets, four-way heuristic split enqueue/poll/download, Deep script shape, 24-bit rendering, unknown DSP fields, missing/invalid fields, spoofed non-audio, path traversal, cancellation and cross-origin rejection. The runner separately probes upload limits and foreign Host rejection. Test names express their intended scope: a finite long-track case does not establish zero leaks, and frequency decomposition tests do not validate source separation quality. Current-session outcomes belong in [the ledger](../.claude/war-room/ledger.md).
