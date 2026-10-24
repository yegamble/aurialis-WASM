<!-- cspell:words Emscripten OPFS -->

# Private fixture harness

Generated audio and actual native/browser PCM results are retained in private output directories. The committed [qualification evidence](../qualification/README.md) freezes their hashes and records 23 positive passes plus one uncovered mono HE-AAC diagnostic. No encoded or compiled binary is committed here. The 31 passing synthetic JavaScript unit cases do not independently establish a codec pass.

After the Chair releases setup/CPU work, generate deterministic synthetic tones, impulses, silence, negative-zero Float32 inputs where applicable, and EOF markers using a separately pinned native encoder. Preserve exact encoder flags, source hashes and expected decoder-native output. Do not use user recordings or download a music corpus.

`harness.mjs` accepts only generated fixture bytes and requires injected actual Go CDR and shared memory adapters. It cannot read an old OPFS library or make an audio network request. Its decoder client requires a served private artifact directory with the generated assets manifest; no public route is installed by this experiment.

Run `node --test experiments/legacy-audio-decoder/fixtures/*.test.mjs` with Node 26 for the lightweight synthetic units. Keep these separate from actual decoder and browser checks. Record every failed fixture before correcting source, and establish tolerances before inspecting new decoder results. Native Go CDR must independently accept and measure the final canonical PCM.

The failed baseline Build03 linked a 990,414-byte runtime WASM core; its actual imported memory and Emscripten abort/no-op syscall stubs were inspected without instantiating it. Packaging failed, so that is not a successful build or codec gate.

`decoder-cases.c` includes the real wrapper with linker-wrapped parse/decode entrypoints. Its 22 cases use only FFmpeg allocation, layout and dictionary helpers. They cover synthetic sticky I/O, same-call EOF/error, first-failure preservation and aggregate metadata boundaries. Build04 compiled the separate test module, but the initial loader failed before any case. Corrected relink05 passed all 22 synthetic WASM C cases. No compressed parser or audio codec executed. After a successful private build, use Node 26:

```bash
node experiments/legacy-audio-decoder/fixtures/run-cases.mjs /absolute/private-output
```

The launcher writes `unit/cases-result.json`; the test exports are never packaged as runtime assets. This test does not parse compressed input or decode audio.

Build04 packaged a 991,492-byte runtime core and 1,053,293-byte asset set. Its synthetic launch RED remains separate from that compile/package pass. Corrected initialization passed in a real Chromium DedicatedWorker under strict CSP/COOP/COEP: exact supplied-memory identity, fixed 64 MiB, ABI/export presence, failed growth and zero input reads, without opening a decoder. Exactly five GET requests and no external request/error were observed. The later finite generated-fixture comparison qualifies only its recorded positive cases. Aggregate browser RSS, crash cleanup of detached Chromium, audio speed, busy-C cancellation and broader codec/profile coverage remain unqualified.

The committed `inspect-built-module.mjs` and `runtime-init-probe.mjs` reproduce the private artifact and no-open checks. The latter accepts private output and repository paths; it installs no application route. Keep an external 45-second owned-process watchdog and preserve stdout/stderr/driver status as in the recorded execution. Its test server serves only known immutable assets and rejects non-GET/HEAD; a fresh browser context blocks other methods/origins before navigation.
