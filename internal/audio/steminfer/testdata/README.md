# Stem separator parity checks
<!-- cspell:words PyTorch steminfer oracle fullwindow GOMAXPROCS VECLIB OPENBLAS safetensors BabySlakh Manilow Wichern Seetharaman WASPAA SISDR -->

These scripts compare the Go port with the original PyTorch BS-RoFormer. They are development tools: Python, PyTorch and NumPy are never runtime dependencies, and no model or audio is committed.

- `oracle.py` writes the original model's intermediate tensors and PCM for a short fixture.
- `fullwindow_oracle.py` runs one full 20-second window, optionally from a source WAV.

Both load the original checkpoint (`mvsep_mega_model_bs_roformer_53_stems_v1.ckpt`, SHA-256 `c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f`) only after its checksum matches, with `weights_only=True, mmap=True`. See [NOTICE](../NOTICE) and [MODEL-LICENSE.txt](../MODEL-LICENSE.txt).

## Opt-in Go tests

Set `AURIALIS_STEM_MODEL` to the five-head `safetensors` file to run the model-backed tests:

- `TestParallelLanesMatchSerialInferenceExactly`: one lane and six lanes give identical output.
- `TestStoreDownloadsOnceAndReplacesCorruptCache`: first-use download through a local server.
- `TestOriginalPyTorchIntermediateAndPCMParity` and `TestOriginalNeuralPortFromExactFeatures`: also set `AURIALIS_STEM_ORACLE` to an `oracle.py` output directory.
- `TestMeasureFixedTwentySecondTrainedPipeline`: also set `AURIALIS_STEM_MEASURE_PIPELINE=1` to time one full window.
- `TestFullWindowMatchesPyTorchOriginal`: also set `AURIALIS_STEM_FULL_ORACLE` to a `fullwindow_oracle.py` output directory. Every head must stay within `1e-4` and above 80 dB SNR. Generate the directory with the full window, which is not the script's default:

  ```sh
  python3 fullwindow_oracle.py --checkpoint mvsep_mega_model_bs_roformer_53_stems_v1.ckpt --out /tmp/full-oracle --samples 882000 --threads 4
  ```

  Add `--broadband` for a noise fixture or `--source-wav` for a canonical 44.1 kHz stereo float32 WAV of at most 882,000 frames. The output is `oracle.json` plus about 70 MB of `oracle.bin`.

## Recorded results — 2026-10-23 and 2026-10-25

Against the full-window PyTorch original, all five Go heads and the residual matched within the short-oracle tolerances (maximum PCM difference about `3.2e-5`). On a constructed fixture from [BabySlakh v2](https://zenodo.org/records/4603870) Track00005 (Ethan Manilow, Gordon Wichern, Prem Seetharaman and Jonathan Le Roux, CC BY 4.0; *Cutting Music Source Separation Some Slakh*, WASPAA 2019), Go SI-SDR was vocals 15.69 dB, drums 12.81, bass 12.77, guitar 11.72, piano 0.63 and Other −4.42. That is one track; piano and Other are weak.

One 20-second window took 97 s on one core and 32 s across all cores of an 8-core M2 with Accelerate. The plain-Go matrix path did not finish a window in 30 minutes.
