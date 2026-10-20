# Aurialis-WASM API & Postman/Newman Reference

Maintained by [`aurialis-tech-writer`](../.claude/agents/aurialis-tech-writer.md) and verified by [`aurialis-qa`](../.claude/agents/aurialis-qa.md) and [`aurialis-security`](../.claude/agents/aurialis-security.md) using Postman/Newman and `curl`.

---

## 1. Required Security & Isolation Headers

All HTML and asset responses from the `aurialis` Go binary include:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'
```

- WASM modules (`/wasm/*.wasm`) are served with `Content-Type: application/wasm`.
- State-changing requests (`POST`, `PUT`, `DELETE`, `PATCH`) validate `Host` (loopback `127.0.0.1` / `localhost` / `[::1]` by default) and `Origin` / `Sec-Fetch-Site` headers, returning `403 Forbidden` on DNS-rebinding or cross-origin localhost CSRF attempts.
- Uploaded audio files undergo **Audio Content Disarm & Reconstruction (CDR)**: user filenames never touch the host filesystem, non-audio metadata/trailer chunks (`LIST`, `INFO`, `ID3`, `JUNK`, `PAD`) and polyglot payloads (`MZ`, `ELF`, Mach-O, `PK\x03\x04` ZIP/JAR, `%PDF`, scripts) are stripped or rejected (`400 Bad Request`), and audio is decoded strictly into bounded `float32` PCM buffers.

---

## 2. HTTP Endpoints

### `GET /health`
- **Response (`200 OK`)**:
  ```json
  {
    "status": "ok",
    "service": "aurialis-wasm",
    "version": "0.1.0"
  }
  ```

### `POST /separate`
Enqueues a Smart Stem Separation job for exact stem counts `2` through `6`.
- **Content-Type**: `multipart/form-data`
  - `file`: Audio binary (WAV, AIFF, FLAC, MP3, OGG, M4A — verified via magic bytes, capped at `MAX_UPLOAD_BYTES_OVERRIDE`).
  - `stems` (or `model`): `2` | `3` | `4` | `5` | `6`
    - `2`: Vocals, Instrumental
    - `3`: Vocals, Drums, Other
    - `4`: Vocals, Drums, Bass, Other
    - `5`: Vocals, Drums, Bass, Melody, Other
    - `6`: Vocals, Drums, Bass, Guitar, Piano, Other
- **Responses**:
  - `202 Accepted`: `{ "jobId": "<uuid>", "status": "queued", "stems": 4 }`
  - `400 Bad Request`: Invalid magic bytes, corrupted RIFF body, invalid stem count, or CRLF/path-traversal filename.
  - `413 Payload Too Large`: Upload exceeds `MAX_UPLOAD_BYTES_OVERRIDE`.

### `POST /analyze/deep`
Enqueues a structure-aware Deep Analysis job producing a version `1` `MasteringScript`.
- **Content-Type**: `multipart/form-data`
  - `file`: Audio binary
  - `profile`: `"modern_pop_polish"` | `"hip_hop_low_end"` | `"indie_warmth"` | `"metal_wall"` | `"pop_punk_air"`
- **Responses**:
  - `202 Accepted`: `{ "jobId": "<uuid>", "status": "queued", "profile": "modern_pop_polish" }`
  - `400 Bad Request` / `413 Payload Too Large`

### `GET /jobs/{id}`
Polls job progress and returns results when `status == "done"`.
- **Response (`200 OK`)**:
  - Phases for Deep Analysis: `detecting_sections` → `analyzing_stems_and_artifacts` → `writing_mastering_script` → `done`.
  - When `done`, includes `script` conforming to the `MasteringScript` v1 contract (`version: 1`, `trackId`, `sampleRate`, `duration`, `profile`, `sections[]`, `moves[]` across `Volume`, `EQ`, `Comp/Sat`, `Width`, `AI Repair`, and `findings[]`).

### `DELETE /jobs/{id}`
Cancels an in-flight job or cleans up a completed job idempotently.
- **Response**: `200 OK` (idempotent on repeated `DELETE` calls) or `404 Not Found` for unknown job IDs.

### `GET /jobs/{id}/stems/{stemName}`
Downloads a separated stem audio stream. Rejects any `../` or path-separator traversal with `400`/`404`.

---

## 3. Postman / Newman Test Matrix (`TS-001` – `TS-013`)

| ID | Scenario | Expected Outcome |
|---|---|---|
| `TS-001` | Health Check (`GET /health`) | `200 OK` + COOP/COEP headers present |
| `TS-002` | Separate Enqueue (`POST /separate`, 2–6 stems) | `202 Accepted` with valid `jobId` |
| `TS-003` | Deep Analyze Round-Trip (`POST /analyze/deep` → `GET /jobs/{id}`) | Polls to `done`; validates `MasteringScript` v1 JSON schema |
| `TS-004` | Cancel Job (`DELETE /jobs/{id}`) | Cancels in-flight job & returns `200 OK` idempotently |
| `TS-005` | Audio Edge Cases | Handles `<1s` tiny audio, mono 8 kHz, and mono 96 kHz without panic |
| `TS-006` | Reject Non-Audio | PDF, EXE, and spoofed `.wav` rejected with `400 Bad Request` |
| `TS-007` | Reject Oversized Upload | 250 MB payload with `MAX_UPLOAD_BYTES_OVERRIDE=209715200` returns `413` |
| `TS-008` | Reject Corrupted WAV | Valid `RIFF`/`WAVE` magic bytes with truncated/corrupt body returns `400` |
| `TS-009` | Invalid Params & CRLF Injection | Unknown profile/stem count or `\r\n` filename returns `400` |
| `TS-010` | Path Traversal Guard | `GET /jobs/{id}/stems/../../etc/passwd` rejected (`400`/`404`) |
| `TS-011` | CORS Preflight | Allowed origin succeeds; disallowed origin rejected |
| `TS-012` | Long Audio (10-minute track) | Completes within memory budget with zero buffer leaks |
| `TS-013` | Stem Download | Happy path `200 OK` audio stream; missing stem `404` |
| `TS-014` | Audio CDR Polyglot & Host Protection (`aurialis-security`) | WAV+ZIP (`PK\x03\x04`) polyglot, WAV header `0xFFFFFFFF` overflow, RTLO `\u202e` filename, and cross-origin `Origin: https://evil.example` / `Host: evil.example` probes rejected (`400`/`403`) with zero residual files in temp dir |
