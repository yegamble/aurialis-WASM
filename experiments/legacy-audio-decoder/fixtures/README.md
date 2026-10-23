# Private fixture harness

No encoded audio fixtures or actual decoder/browser results are present yet. The 24 passing synthetic unit cases do not establish a codec pass.

After the Chair releases setup/CPU work, generate deterministic synthetic tones, impulses, silence, negative-zero Float32 inputs where applicable, and EOF markers using a separately pinned native encoder. Preserve exact encoder flags, source hashes and expected decoder-native output. Do not use user recordings or download a music corpus.

`harness.mjs` accepts only generated fixture bytes and requires injected actual Go CDR and shared memory adapters. It cannot read an old OPFS library or make an audio network request. Its decoder client requires a served private artifact directory with the generated assets manifest; no public route is installed by this experiment.

Run `node --test experiments/legacy-audio-decoder/fixtures/*.test.mjs` with Node 26 for the lightweight synthetic units. Keep these separate from actual decoder and browser checks. Record every failed fixture before correcting source, and establish tolerances before inspecting new decoder results. Native Go CDR must independently accept and measure the final canonical PCM.

Asset/package sizes, dependency imports, CSP behavior, memory use, speed, cancellation and all codec/profile coverage remain unmeasured.
