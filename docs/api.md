# Aurialis-WASM API & Postman/Newman Reference
<!-- cspell:words Embedder -->

Maintained by [`aurialis-tech-writer`](../.claude/agents/aurialis-tech-writer.md) and verified by [`aurialis-qa`](../.claude/agents/aurialis-qa.md) and [`aurialis-security`](../.claude/agents/aurialis-security.md) using Postman/Newman and raw `curl` security probes.

---

## 1. Required Security & Isolation Headers

All HTTP responses from the `aurialis` Go binary (`cmd/aurialis`, `internal/server`) attach hardened headers required for browser `SharedArrayBuffer` / `AudioWorklet` isolation and host workstation protection:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'
```

- **WASM Modules**: Static `.wasm` files (`/wasm/*.wasm`) are served with `Content-Type: application/wasm`.
- **DNS-Rebinding Defense**: `Host` headers must resolve to loopback (`127.0.0.1`, `localhost`, `::1`, or `0.0.0.0`). Any non-local `Host` returns `403 Forbidden` (`forbidden_host`).
- **Localhost CSRF Defense**: On state-changing methods (`POST`, `PUT`, `DELETE`, `PATCH`), requests with `Sec-Fetch-Site: cross-site` return `403 Forbidden` (`csrf_rejected`), and requests with an untrusted external `Origin` return `403 Forbidden` (`forbidden_origin`).
- **Audio Content Disarm & Reconstruction (CDR)**: Uploaded files are verified via magic bytes, polyglots (`MZ`, `\x7fELF`, Mach-O, `PK\x03\x04` ZIP/JAR trailers, `%PDF`, script tags) are rejected (`400 Bad Request`), all non-audio metadata/trailer chunks (`LIST`, `INFO`, `ID3`, `JUNK`, `PAD`) are stripped, and audio is decoded into bounded `float32` PCM buffers. User-supplied filenames never touch the host filesystem.

---

## 2. HTTP Endpoints

All primary routes are registered at root and `/api/*` prefixes:

### `GET /health` & `GET /api/health`
Returns service readiness, WASM status, supported stem models, and available engineer profiles.
- **Response (`200 OK`)**:
  ```json
  {
    "status": "ok",
    "service": "aurialis-wasm",
    "version": "0.1.0",
    "wasmDsp": true,
    "wasmDspReady": true,
    "gpu": false,
    "models": ["htdemucs", "2", "3", "4", "5", "6"],
    "profiles": [
      "Warm Analog",
      "Punchy Commercial",
      "Dynamic & Open",
      "Vocal Forward",
      "Bass Heavy",
      "modern_pop_polish",
      "hip_hop_low_end",
      "indie_warmth",
      "metal_wall",
      "pop_punk_air"
    ]
  }
  ```

---

### `POST /separate` & `POST /api/separate`
Enqueues a stem separation job for exact stem counts `2` through `6`.
- **Content-Type**: `multipart/form-data`
  - `file`: Audio binary (WAV, AIFF, FLAC, MP3, OGG, M4A — validated via magic bytes, capped by `MAX_UPLOAD_BYTES_OVERRIDE` or default 200 MB).
  - `stems` (or `model`): `2` | `3` | `4` | `5` | `6`
    - Also accepts `model=htdemucs` (defaults to 4 stems) or `model=htdemucs_6s` (defaults to 6 stems).
    - `2`: Vocals, Instrumental
    - `3`: Vocals, Drums, Other
    - `4`: Vocals, Drums, Bass, Other
    - `5`: Vocals, Drums, Bass, Melody, Other
    - `6`: Vocals, Drums, Bass, Guitar, Piano, Other
- **Responses**:
  - `202 Accepted`:
    ```json
    {
      "id": "e8a108a7988358ea",
      "jobId": "e8a108a7988358ea",
      "kind": "separate",
      "status": "queued",
      "stemCount": 4,
      "stems": [
        {
          "id": "vocals",
          "name": "Vocals",
          "role": "vocals",
          "color": "#b4543c",
          "downloadUrl": "/jobs/e8a108a7988358ea/stems/vocals",
          "url": "/jobs/e8a108a7988358ea/stems/vocals"
        }
      ]
    }
    ```
  - `400 Bad Request`: `missing_file`, `invalid_audio`, or `invalid_parameter`.
  - `413 Request Entity Too Large`: `payload_too_large` when upload exceeds byte ceiling.
  - `503 Service Unavailable`: `queue_full` when concurrent worker pool is saturated.

---

### `POST /analyze/deep` & `POST /api/analyze/deep`
Enqueues a structure-aware Deep Analysis job producing a version 1 `MasteringScript`.
- **Content-Type**: `multipart/form-data`
  - `file`: Audio binary
  - `profile`: Canonical profile (`"Warm Analog"`, `"Punchy Commercial"`, `"Dynamic & Open"`, `"Vocal Forward"`, `"Bass Heavy"`) or UI alias (`"modern_pop_polish"`, `"hip_hop_low_end"`, `"indie_warmth"`, `"metal_wall"`, `"pop_punk_air"`).
- **Responses**:
  - `202 Accepted`:
    ```json
    {
      "id": "c1f4e92a8371bd90",
      "jobId": "c1f4e92a8371bd90",
      "kind": "analyze_deep",
      "status": "queued",
      "profile": "Warm Analog"
    }
    ```
  - `400 Bad Request`: `missing_file`, `invalid_audio`, or `invalid_profile`.
  - `413 Request Entity Too Large`: `payload_too_large`.
  - `503 Service Unavailable`: `queue_full`.

---

### `POST /api/master/render` & `POST /master/render`
Synchronously renders an uploaded audio track through the calibrated Go/WASM mastering DSP chain and returns a clean, disarmed WAV file with acoustic loudness headers, or a JSON report.
- **Content-Type**: `multipart/form-data`
  - `file`: Audio binary
  - `profile` (optional): Canonical profile name or UI profile alias.
  - `params` (optional): Serialized JSON representing `dsp.Params` overrides.
  - `bitDepth` (optional): `16`, `24` (default), or `32`. TPDF dither is applied automatically for 16-bit and 24-bit exports.
  - `format` (optional): Set to `"json"` or pass header `Accept: application/json` to receive structured metrics instead of a binary file.
- **Responses**:
  - `200 OK` (Default WAV binary):
    - `Content-Type: audio/wav`
    - `Content-Disposition: attachment; filename="aurialis-mastered.wav"`
    - `X-Aurialis-Before-LUFS`: Integrated LUFS before mastering (e.g. `-18.42`)
    - `X-Aurialis-After-LUFS`: Integrated LUFS after mastering (e.g. `-14.05`)
    - `X-Aurialis-After-Peak-dBTP`: True-peak dBTP after limiting (e.g. `-0.80`)
  - `200 OK` (JSON format):
    ```json
    {
      "status": "ok",
      "sampleRate": 48000,
      "frames": 19200,
      "duration": 0.4,
      "bitDepth": 24,
      "params": { ... },
      "beforeMetrics": {
        "integratedLufs": -18.42,
        "truePeakDbtp": -3.50,
        "loudnessRangeLu": 6.2,
        "stereoCorrelation": 0.94
      },
      "afterMetrics": {
        "integratedLufs": -14.05,
        "truePeakDbtp": -0.80,
        "loudnessRangeLu": 5.1,
        "stereoCorrelation": 0.96
      }
    }
    ```
  - `400 Bad Request`: `missing_file`, `invalid_audio`, `invalid_profile`, or `invalid_params`.
  - `413 Request Entity Too Large`: `payload_too_large`.
  - `500 Internal Server Error`: `encode_error`.

---

### `GET /jobs/{id}`, `GET /jobs/{id}/status`, `GET /jobs/{id}/result`
Polls status and retrieves results of background stem separation or Deep Analysis jobs.
- **Path Parameter**: `id` (must not contain path traversal `..` or `/`).
- **Query Parameter**: `?wait=1` enables server-side long-polling (blocks up to 4 seconds while `status` is `queued` or `running`).
- **Lifecycle States**:
  - `queued`: Waiting for a worker in the bounded pool.
  - `running`: Executing DSP or acoustic analysis.
  - `done`: Processing finished successfully; artifacts ready.
  - `cancelled`: Job was canceled by user request.
  - `failed`: Job encountered an unrecoverable error.
- **Response (`200 OK`)**: Returns full Job object. When `status == "done"`, `script` contains the complete `MasteringScript` v1 (`sections[]`, `moves[]` across 5 automation lanes, `findings[]`, `chainParams`, `beforeMetrics`, `afterMetrics`), or `stems[]` contains the downloadable stem list.
- **Errors**: `400 Bad Request` (`invalid_job_id`), `404 Not Found` (`job_not_found`).

---

### `DELETE /jobs/{id}` & `DELETE /api/jobs/{id}`
Cancels an active job or cleans up completed job artifacts idempotently.
- **Response (`200 OK`)**: Returns the canceled Job object (`status: "cancelled"`).
- **Errors**: `400 Bad Request` (`invalid_job_id`), `404 Not Found` (`job_not_found`).

---

### `GET /jobs/{id}/stems/{stemName}` & `GET /api/jobs/{id}/stems/{stemName}`
Downloads a separated stem audio stream (`vocals`, `drums`, `bass`, `other`, `guitar`, `piano`, with or without `.wav` suffix).
- **Response (`200 OK`)**:
  - `Content-Type: audio/wav`
  - `Content-Disposition: attachment; filename="<stemName>.wav"`
- **Errors**:
  - `400 Bad Request` (`invalid_stem_path`): Stem or job ID contains path traversal (`..`, `/`, `\`).
  - `404 Not Found` (`stem_not_found`): Stem does not exist for the specified job.

---

## 3. Postman / Newman & cURL Test Matrix (`TS-001` – `TS-015`)

The backend test suite is executed via:

```bash
pnpm run test:backend:postman
```

which invokes `tests/postman/run-newman.sh` against a fresh compiled `aurialis` binary with bounded upload caps and worker pools.

| ID | Scenario | Verification Target |
|---|---|---|
| `TS-001` | Health Check (`GET /health`) | `200 OK`, `wasmDspReady: true`, profiles, models, COOP/COEP headers present |
| `TS-002` | Separate Enqueue (`POST /separate`, 2–6 stems) | `202 Accepted` with valid `jobId` and stem descriptors |
| `TS-003` | Deep Analyze Round-Trip (`POST /analyze/deep` → `GET /jobs/{id}?wait=1`) | Polls to `done`; validates `MasteringScript` v1 JSON schema |
| `TS-004` | Cancel Job (`DELETE /jobs/{id}`) | Cancels job and returns `200 OK` (`status: "cancelled"`) idempotently |
| `TS-005` | Audio Edge Cases | Short (<1s), mono 8 kHz, and mono 96 kHz streams handled cleanly |
| `TS-006` | Reject Non-Audio | PDF, EXE, and spoofed `.wav` rejected with `400 Bad Request` (`invalid_audio`) |
| `TS-007` | Reject Oversized Upload | Exceeding `MAX_UPLOAD_BYTES_OVERRIDE` returns `413 Request Entity Too Large` |
| `TS-008` | Reject Corrupted WAV | Valid `RIFF`/`WAVE` header with truncated body returns `400 Bad Request` |
| `TS-009` | Invalid Params & Injection | Unknown profile, invalid stem count, or `\r\n` filenames return `400` |
| `TS-010` | Path Traversal Guard | `GET /jobs/{id}/stems/../../etc/passwd` rejected with `400` (`invalid_stem_path`) |
| `TS-011` | Localhost Rebinding & CSRF Guard | Foreign `Host` (`evil.attacker.com`) or cross-origin state-changing `Origin` returns `403` |
| `TS-012` | Long Audio Stability | 10-minute track processed in bounded memory with zero goroutine or memory leaks |
| `TS-013` | Stem Download | Successful stem retrieval returns `200 audio/wav`; invalid stem returns `404` |
| `TS-014` | Direct Master Render (`POST /api/master/render`) | Validates `audio/wav` download with `X-Aurialis-*-LUFS` headers, and `format=json` metrics |
| `TS-015` | Audio CDR Polyglot & Clean Reconstruction | Strips non-audio chunks/polyglots (`PK\x03\x04`), re-synthesizes pristine PCM audio |
| `curl-413` | Raw cURL Oversized Body Probe | Streams 1.2 MB file against 1 MB ceiling and asserts immediate `413` exit code |
| `curl-dns` | Raw cURL Host Header Rebinding Probe | Probes with `-H "Host: evil.attacker.com"` and asserts immediate `403` exit code |

---

## 4. Known Implementation Caveats

1. **Client TS DSP vs. Go/WASM Reference Engine**: The browser client includes a per-sample TypeScript DSP chain (`src/lib/audio-dsp.ts`) featuring a 1-pole mono-bass crossover and sample-peak limiter for low-latency interactive UI adjustments, whereas the Go/WASM engine (`internal/audio/dsp`, `wasm/dsp`) is the calibrated reference implementation featuring ZDF/TPT SVF filters, 4th-order Linkwitz-Riley crossover, and 4× oversampled True-Peak limiting.
2. **AudioWorklet Live Playback**: Interactive preview playback currently runs through `HTMLAudioElement` and client TypeScript DSP; routing real-time browser playback directly through the compiled WASM `AudioWorklet` processor is scheduled for a subsequent integration slice.
3. **Simple-Mode Metrics Estimation**: Simple-mode UI metrics are parameter-estimated approximations rather than measured directly from decoded PCM waveforms.
4. **Vulnerability Gate (`govulncheck`)**: `govulncheck ./...` reports Go standard library finding `GO-2026-6617` on Go `1.26.2`, which is remediated in Go `1.26.9`.

