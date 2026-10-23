# Private original normalization fixture
<!-- cspell:words RMSNorm sqrt rmsnorm minsub WGSL PyTorch Solovyev FTZ readback subnormal subnormals gamma reassociation gofmt steminfer safetensors -->

This isolated development harness tests **original L2 normalization scaled by sqrt256**, often named RMSNorm in the model. It keeps `max(L2 norm, 1e-12)`, division, multiplication by 16 and raw gamma. It loads no model or audio in the browser and has no application import or public route. The unchanged upstream single-pass shader remains a historical control; its pre-scaled gamma is not used here.

The exporter calls the actual Go `normalizeRows` implementation. A separate Python exporter extracts the unchanged RMSNorm class from checksum-pinned original MIT source, verifies the original checkpoint and calls that class with its exact widened F16 gamma. Both actual outputs and raw norms remain in each fixture. Go accumulates squares in Float64; the original PyTorch backend reduces Float32. Their differences are reported separately and neither trace replaces the other. No model forward pass is needed.

The fixture uses two dispatches with an observable F32 storage boundary. The first writes a positive F32 reduction tree's denominator and divided quotient. The second reads that quotient, then applies 16 and raw gamma. All three stages are returned together with canaries and one success/failure result. This is a distinct reduction implementation, not a claim that Torch and Go use the same order. GPU per-pass timestamps are not requested; the report states the cold submit-to-all-readback interval only.

## Declared checks

The positive-tree reference uses one rounded square and eight positive additions. Its normal-arithmetic sum bound is `gamma(9) * sumSquares`, with `u=2^-24`. A conservative 12u relative margin covers the inherited square-root accuracy. The stored quotient has a `5u * abs(x/d) + 3 * 2^-149` margin around division using the **observed** denominator. Final multiplication is checked against all three associations of quotient,16 and raw gamma. These component diagnostics use the [WGSL arithmetic accuracy and reassociation rules](https://www.w3.org/TR/WGSL/#floating-point-accuracy); they are not universal model or audible-error guarantees.

Ordinary applicability requires nonzero relevant intermediates to be normal: input squares, stored quotient, gamma, `q*gamma`, `16*gamma`, `q*16` and the final product. Underflow/FTZ/reassociation cases are explicitly limited diagnostics. Their stage checks separately include permitted subnormal flushing and multiplication associations. They never enlarge the ordinary bound. Signed-zero differences are reported.

Independent review rejected the earlier `gamma(32)*abs(ideal)+4minsub` proposal: a tiny quotient's rounding can be amplified 512 times by 16 and gamma 32. That exact counterexample is retained. Other fixtures expose single-pass reassociation before division, and pass 2 reassociation where an intermediate is subnormal but the final ideal is normal. Storing the quotient addresses the former; the latter remains explicitly limited.

The closed shape is 1–512 rows of 256 values. Inputs must be finite with magnitude at most `sqrt(MaxFloat32/512)`; gamma must be finite with magnitude at most 32. A finite 1e30 overflow example must reject before worker creation. Safe integer indices, padded work, CPU reference work and device limits are checked. The declared application-buffer charge is `30*xBytes + 12*gammaBytes + 64*rows + 8192`, below 16 MiB even at 512 rows. It covers the caller, immutable private snapshot, worker transfer, hash input, saved Go/Torch references, initialization and GPU/upload/readback/mapped/returned copies. Opaque driver/device allocation and process RSS are outside this count.

Each fixture owns a fresh worker/device; there is no queue. The client snapshots every comparison byte before awaiting anything. The worker accepts only hashes from the generated exact Go/original fixture index and a literal pinned shader. Unknown/edited references fail before device creation. A five-second watchdog allows 50 ms for explicit buffer/device cleanup and then terminates the worker. Cancellation, device loss and all error paths destroy resources. This does not certify immediate GPU preemption.

## Generate traces and prepare

Use fresh absolute output paths under ignored private artifacts. Go tests run from the package directory. These commands require the recovered model, original checkpoint, pinned original source and original broadband trace, never a network download. The first command performs only normalization fixture export; the second performs only original normalization, not inference.

```sh
AURIALIS_STEM_MODEL=RECOVERED_MODEL_FILE \
AURIALIS_NORM_ORIGINAL_TRACE=ORIGINAL_BROADBAND_TRACE_DIRECTORY \
AURIALIS_NORM_FIXTURE_DIR=FRESH_GO_TRACE_DIRECTORY \
  go test ./internal/audio/steminfer -run '^TestWriteOriginalNormalizationFixtures$' -count=1 -v
python3 -B internal/audio/steminfer/testdata/normalization_oracle.py \
  --checkpoint ORIGINAL_CHECKPOINT --source PINNED_ORIGINAL_SOURCE \
  --go-fixtures FRESH_GO_TRACE_DIRECTORY --out FRESH_COMBINED_TRACE_DIRECTORY
python3 -B internal/audio/steminfer/testdata/webgpu/norm/prepare.py \
  --fixtures FRESH_COMBINED_TRACE_DIRECTORY --out FRESH_NORM_HARNESS_DIRECTORY
python3 -B internal/audio/steminfer/testdata/webgpu/norm/serve.py \
  --root FRESH_NORM_HARNESS_DIRECTORY --port 3939
```

The closed loopback server serves code through GET/HEAD only. Select local fixture files through the picker; bytes stay in the page/worker and are never submitted over HTTP. A hardware run requires a separately coordinated quiet window and an actual adapter report. Earlier Brave scalar hardware evidence does not qualify this new kernel.

## Current evidence

Thirteen distinct Node contract/mock-worker checks passed, with no GPU execution. They cover resource/shape/device limits, nonfinite and overflow refusal, saved-Go-reference integrity, independent stage corruption, the rejected-bound counterexample, separately limited FTZ/reassociation, immutable publication, one-active admission, exact identities, cleanup and deadline behavior. Python source syntax checks passed without importing Torch. The actual Go exporter passed 32 traces (0.29 seconds in the test; 0.520 seconds outer). The independent checksum-pinned original class exported the same 32 cases with PyTorch 2.8.0, one thread and zero model forward passes. The first Go invocation used relative paths and failed immediately because tests run in the package directory; the absolute-path retry passed. WGSL compilation and the hardware batch remain **unexecuted** for this slice. This remains private work; no full-model conformance, performance or product capability follows.
