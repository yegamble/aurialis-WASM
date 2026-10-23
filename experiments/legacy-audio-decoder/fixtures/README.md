# Private fixture harness

No encoded audio fixtures or actual decoder/browser results are present yet. The 31 passing synthetic JavaScript unit cases do not establish a codec pass.

After the Chair releases setup/CPU work, generate deterministic synthetic tones, impulses, silence, negative-zero Float32 inputs where applicable, and EOF markers using a separately pinned native encoder. Preserve exact encoder flags, source hashes and expected decoder-native output. Do not use user recordings or download a music corpus.

`harness.mjs` accepts only generated fixture bytes and requires injected actual Go CDR and shared memory adapters. It cannot read an old OPFS library or make an audio network request. Its decoder client requires a served private artifact directory with the generated assets manifest; no public route is installed by this experiment.

Run `node --test experiments/legacy-audio-decoder/fixtures/*.test.mjs` with Node 26 for the lightweight synthetic units. Keep these separate from actual decoder and browser checks. Record every failed fixture before correcting source, and establish tolerances before inspecting new decoder results. Native Go CDR must independently accept and measure the final canonical PCM.

The failed baseline Build03 linked a 990,414-byte runtime WASM core; its actual imported memory and Emscripten abort/no-op syscall stubs were inspected without instantiating it. Packaging failed, so that is not a successful build or codec gate.

`decoder-cases.c` includes the real wrapper with linker-wrapped parse/decode entrypoints. Its 22 cases use only FFmpeg allocation, layout and dictionary helpers. They cover synthetic sticky I/O, same-call EOF/error, first-failure preservation and aggregate metadata boundaries. Build04 compiled the separate test module, but actual launch failed because required incoming loader options were omitted; no C case ran. The corrected relink is pending. After a successful private build, use Node 26:

```bash
node experiments/legacy-audio-decoder/fixtures/run-cases.mjs /absolute/private-output
```

The launcher writes `unit/cases-result.json`; the test exports are never packaged as runtime assets. This test does not parse compressed input or decode audio.

Build04 packaged a991,492-byte runtime core and1,053,293-byte asset set. Its synthetic launch RED remains separate from that compile/package pass. Corrected initialization, actual CSP/browser behavior, runtime memory use, audio speed, busy-C cancellation and all codec/profile coverage remain unqualified.
