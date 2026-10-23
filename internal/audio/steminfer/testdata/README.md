# Private trained-stem qualification
<!-- cspell:words BabySlakh Slakh CyclePat PyTorch RoPE F32 F16 VECLIB OPENBLAS GOMAXPROCS SISDR Manilow Wichern Seetharaman WASPAA heldout mmap fullwindow steminfer clavinet -->

These development tools do not enable a public separation route or browser model. All PCM and inference stay on the local device. Python, PyTorch, NumPy, SciPy and SoundFile are development dependencies, not product runtime dependencies. The native private probe currently uses Apple Accelerate; portable and browser performance remain unqualified.

## Pinned sources and attribution

The original Mega53 checkpoint has SHA-256 `c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f`. The recovered five-head archive has SHA-256 `0d51845078d4c075d825ba18f776f9af96e50d34d3491102a1215b6dbaf684b7`; all 1,691 selected existing F16 tensors were independently byte-compared with the original. It differs from the lost historical container hash. The strict loader uses the explicit recovered pin. Original F16 RoPE frequencies, model epsilon, five heads and the 882,000-sample context remain unchanged. See [the code notices](../NOTICE) and [licenses](../LICENSE).

Truth fixtures use [BabySlakh v2](https://zenodo.org/records/4603870), by Ethan Manilow, Gordon Wichern, Prem Seetharaman and Jonathan Le Roux, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Cite *Cutting Music Source Separation Some Slakh*, WASPAA 2019. The author archive is 882,818,115 bytes, published MD5 `311096dc2bde7d61c97e930edbfc7f78`, freshly verified SHA-256 `6490dc83d8b59ccbe7e9e0304023af8e585d2065f9a5f5921952a273fac4a9b0`.

The provided vocal is [CyclePat's GloriaGregorianChant.ogg](https://commons.wikimedia.org/wiki/File:GloriaGregorianChant.ogg), under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), SHA-256 `f3cefaad551c24e81413f9c3a4a492fd519174697808056a6ee7c559e29140ce`. The creator describes singing through a keyboard/software recording chain; this is not an independently certified a cappella recording. Fixture manifests identify excerpts, grouping, resampling, panning, level changes and remixing. No creator endorses this evaluation.

`recover_evaluation.py` extracts only regular, bounded metadata/stem files from Track00005 and Track00012. These exclude the earlier Track00001/Track00020 evaluation; model training membership is unknown. `prepare_heldout.py` selects the earliest active 10-second window by a fixed truth-only rule, without consulting predictions. It saves six truth groups and their float32 sum, with source/output hashes and attribution. Synthetic choir patches remain Other under the source taxonomy, so instrument/vocal-category overlap can affect results.

## Run the private comparison

Recover the pinned archives and vocal separately into an ignored research directory. Download with a bounded rate and verify checksums before loading. Fixture extraction never uses unrestricted archive extraction, and the original checkpoint loads only through `weights_only=True, mmap=True` after its checksum matches.

1. Run `recover_evaluation.py --archive ARCHIVE --out SELECTED_DIRECTORY`, then `prepare_heldout.py --selected SELECTED_DIRECTORY --vocal VOCAL_OGG --out TRUTH_DIRECTORY`. These tools refuse existing output files.
2. Compare the unchanged `oracle.py` with `fullwindow_oracle.py --broadband --capture-all` on the default 2,053-sample fixture first. The new diagnostic tiles independent batches/queries while retaining every key. It does not replace the original conformance oracle.
3. Run `fullwindow_oracle.py --checkpoint ORIGINAL_CHECKPOINT --out ORACLE_DIRECTORY --source-wav MIXTURE_WAV --samples 882000 --threads 1`. Use `VECLIB_MAXIMUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1` and `OMP_NUM_THREADS=1`; coordinate a quiet host and impose an outer deadline. Full intermediate capture is restricted to short fixtures.
4. Set `AURIALIS_STEM_QUALIFICATION=1`, `AURIALIS_STEM_MODEL`, `AURIALIS_STEM_QUALIFICATION_SOURCE` and `AURIALIS_STEM_QUALIFICATION_OUTPUT`. Run `go test ./internal/audio/steminfer -run '^TestMeasureLicensedTrainedPipeline$' -count=1 -v -timeout 150s` with the same thread policy and `GOMAXPROCS=1`. The recorder logs its newly created output directory.
5. Run `measure_quality.py --truth TRUTH_FIXTURE_DIRECTORY --native NATIVE_OUTPUT_DIRECTORY --oracle ORACLE_DIRECTORY --out REPORT_JSON`. Run `test_quality.py` for silent-truth, zero-prediction, gain, DC and unaligned-delay checks.

Every Python command above uses the script in this directory. The recorder accepts exactly 441,000 stereo frames at 44.1 kHz and runs one padded full 20-second graph with all five heads. It saves six finite float32 outputs at the exact source duration. Other is the original PCM minus the delivered selected heads; exact residual subtraction and reconstruction are invariants, not evidence of musical separation quality. Raw SDR/RMS ratio and DC error accompany zero-mean SI-SDR; predictions receive no time or output-gain adjustment.

## Observed checkpoint — 2026-10-23

Durable ignored evidence is indexed in `artifacts/private-stems/recovery-20261023/QUALIFICATION.json`. No model or audio assets are committed. Short broadband original versus tiled PyTorch traces were bit-identical. Go versus original short broadband passed with maximum PCM error about `2.20e-6`.

The original tonal conformance test remains **red** at unchanged tolerances. A fresh PyTorch self-comparison of its F32 FFT versus F64 FFT rounded to F32 reproduced feature error about `3.91e-6`, but bass PCM error `0.01267` and normalized RMS error `0.579`. The F64 variant is a conditioning diagnostic and never replaces the F32 expected oracle.

On the constructed Track00005 fixture, full-window original PyTorch completed in 127.31 seconds, with observed RSS 1,127,743,488 bytes. The Go pipeline completed in 99.98 seconds (100.52 seconds outer wall time), with observed RSS 480,608,256 bytes. The native reservation was 317,196,720 job bytes plus the separate 176,487,688-byte static archive; retained PCM was 21,168,000 bytes, with another 21,168,264 encoded artifact bytes in this recorder. These are bounded measurements and declared storage, not total memory or deadline guarantees.

All five native heads and residual matched the full-window original within the unchanged short-oracle tolerances: maximum PCM difference about `3.20e-5`; worst normalized RMS error `1.47e-4` for residual Other. Exact source duration and float32 residual subtraction passed, with maximum reconstruction error `3.58e-9`.

| Truth group | Native SI-SDR (dB) | Improvement over mixture (dB) |
| --- | ---: | ---: |
| Vocals | 15.69 | 22.69 |
| Drums | 12.81 | 19.82 |
| Bass | 12.77 | 19.65 |
| Guitar | 11.72 | 18.99 |
| Piano | 0.63 | 7.83 |
| Other | -4.42 | 2.54 |

Original PyTorch produced essentially the same scores. The model has separate `piano`, `digital-piano` and `keys` heads; this unchanged five-head subset uses `piano`, while the Track00005 Piano truth combines acoustic grand and electric/clavinet sources. Keep the combined score and diagnose this coverage difference explicitly; do not relabel truth after seeing predictions. Piano and Other remain weak; this single fixture does not qualify public activation. Track00012 is prepared but **unexecuted**. Broader musical/artifact review, silence and near-silence qualification, actual overlapping-window seams, portable inference, browser GPU limits and distribution/admission remain open. No whole-product or Waves equivalence follows.
