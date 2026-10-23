# Private original normalization fixture
<!-- cspell:words RMSNorm sqrt rmsnorm minsub WGSL PyTorch Solovyev FTZ readback subnormal subnormals gamma reassociation gofmt steminfer safetensors -->

This isolated development harness tests **original L2 normalization scaled by sqrt256**, often named RMSNorm in the model. It keeps `max(L2 norm, 1e-12)`, division, multiplication by 16 and raw gamma. It loads no model or audio in the browser and has no application import or public route. The unchanged upstream single-pass shader remains a historical control; its pre-scaled gamma is not used here.

The exporter calls the actual Go `normalizeRows` implementation. A separate Python exporter extracts the unchanged RMSNorm class from checksum-pinned original MIT source, verifies the original checkpoint and calls that class with its exact widened F16 gamma. Both actual outputs and raw norms remain in each fixture. Go accumulates squares in Float64; the original PyTorch backend reduces Float32. Their differences are reported separately and neither trace replaces the other. No model forward pass is needed.

The fixture uses two dispatches with an observable F32 storage boundary. The first writes a positive F32 reduction tree's denominator and divided quotient. The second reads that quotient, then applies 16 and raw gamma. All three stages are returned together with canaries and one success/failure result. This is a distinct reduction implementation, not a claim that Torch and Go use the same order. GPU per-pass timestamps are not requested; the report states the cold submit-to-all-readback interval only.

## Declared checks

The positive-tree reference uses one rounded square and eight positive additions. Its normal-arithmetic sum bound is `gamma(9) * sumSquares`, with `u=2^-24`. A conservative 12u relative margin covers the inherited square-root accuracy. The stored quotient has a `5u * abs(x/d) + 3 * 2^-149` margin around division using the **observed** denominator. Final multiplication is checked against all three associations of quotient,16 and raw gamma. These component diagnostics use the [WGSL arithmetic accuracy and reassociation rules](https://www.w3.org/TR/WGSL/#floating-point-accuracy); they are not universal model or audible-error guarantees.

Ordinary applicability requires nonzero relevant intermediates to be normal: input squares, the exact source/divisor quotient, stored quotient, gamma, `q*gamma`, `16*gamma`, `q*16` and the final product. Underflow/FTZ/reassociation cases are explicitly limited diagnostics. Their stage checks separately include permitted subnormal flushing and multiplication associations. They never enlarge the ordinary bound. A nonzero source with an observed zero quotient cannot be ordinary. Signed-zero differences are reported.

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

Thirteen distinct CPU-only Node contract/mock-worker checks passed. They cover resource/shape/device limits, nonfinite and overflow refusal, saved-Go-reference integrity, independent stage corruption, the rejected-bound counterexample, separately limited FTZ/reassociation, immutable publication, one-active admission, exact identities, cleanup and deadline behavior. Python source syntax checks passed without importing Torch. The actual Go exporter passed 32 traces (0.29 seconds in the test; 0.520 seconds outer). The independent checksum-pinned original class exported the same 32 cases with PyTorch 2.8.0, one thread and zero model forward passes. The first Go invocation used relative paths and failed immediately because tests run in the package directory; the absolute-path retry passed. Hardware checkpoints are recorded below; the successful component batch still requires independent result review. This remains private work; no full-model conformance, performance or product capability follows.

## Retained first hardware attempt

The fresh headful Brave attempt on the independently identified Apple M2/Metal adapter exited 1 at its 45-second batch watchdog (46.03 seconds outer). The first ten cases passed all declared per-stage checks, with finite output, intact canaries and locally saved quotient/output/denominator bytes. The run then waited for the next diagnostic download until the watchdog expired. No numerical failure was observed in the completed cases. The exact cause of the capture stall remains unverified; multiple-download gating is a hypothesis, not an established diagnosis. Browser and loopback server were closed immediately.

The failed report, progress and ten raw files remain under `artifacts/private-stems/recovery-20261023/webgpu-brave-normalization-*`. A separate driver replaces browser downloads with sequential 8 KiB local automation chunks, exact file/offset/total checks and a 512 KiB additional declared application-buffer allowance. Even the 512-row maximum stays below 16 MiB with that allowance. Shader, source traces and numerical tolerances remain unchanged. Its subsequent measured checkpoint is recorded below; this does not erase the initial watchdog failure.

## Observed chunked-capture checkpoint

On the same independently identified Apple M2/Metal path, fresh headful Brave completed 31 admitted fixtures and refused the finite-overflow case before creating a worker. Outer batch wall time was 2.272 seconds, including fixture/device setup and bounded local capture; this is not a model performance measurement. All outputs were finite, every stage canary remained intact and all 31 quotient/output/denominator buffers were saved with hashes. The observed fixture context made 130 bodyless local GET requests. Brave and the loopback server were closed afterward.

Twenty-six fixtures met the declared ordinary component diagnostics. Five remain explicitly underflow/reassociation-limited: tiny-normal, subnormal-input, subnormal-gamma, quotient-underflow and scale-reassociation-underflow. The tiny-normal and scale-reassociation cases had zero measured output difference while retaining the conservative limited classification. The other three showed the separately reported flushing differences. None of these five is whole-fixture ordinary conformance.

Independent offline recomputation checked every captured stage against both retained actual source traces. Maximum absolute normalized-feature difference was `2.384185791015625e-7` against Go and against original PyTorch. Two deliberate corruptions of saved Go output and captured quotient were refused. Maximum declared application buffers including the extra capture allowance were 10,087,808 bytes; explicitly created GPU buffers were 1,590,784 bytes. Driver/device-internal allocation and process RSS remain unmeasured.

Scoped golangci-lint 2.15 exited 0 after two staticcheck QF1003 test-generator suggestions were corrected from if-chains to switches. The initial failure log is retained. The final normalization-only race test exported 32 cases in 3.416 seconds outer, and every regenerated file plus the entire manifest matched the original Go export byte-for-byte. The original PyTorch references, shader and numerical bounds were unchanged. Independent DSP result review is pending.

The chunked result, raw stages, independent recheck, both source manifests, final race log and initial/final lint logs are indexed in the ignored recovery `QUALIFICATION.json`. The original watchdog report and the earlier headless SwiftShader/no-adapter result remain preserved. This checkpoint is one width 256 operation on one observed adapter; it does not qualify variable-width normalization, attention, the full model, audio quality or public activation.

## Reopened applicability proof

Independent review found that an observed quotient flushed to zero could manufacture an ordinary label. The direct counterexample uses `x[0]=2^-63`, all other inputs `Float32(7e17)` and gamma 32: every square is normal, while the exact quotient is subnormal and later scaling lifts its error to normal range. The original predicate failed the new regression with zero limited elements instead of one. That failing evidence and the historical 31-case report are retained.

The tightened predicate requires both exact source/observed-divisor and source/Go-divisor quotients to be normal-or-zero, alongside the observed quotient, and disallows an observed zero from a nonzero source. Fourteen distinct CPU/mock tests pass. Reclassification of the original 31 raw files still gives 26 ordinary and five limited cases for those exact inputs; it does not erase the source bug. Actual normalization-only race and original PyTorch exports now contain 33 cases including the new counterexample; all previous 32 files in both exports are byte-identical. The corrected 33-case hardware checkpoint is recorded below. Shader and stage error bounds are unchanged.

## Corrected hardware checkpoint

The exact corrected source at `b228a69` completed 32 admitted cases plus one pre-worker overflow refusal in fresh headful Brave on the observed Apple M2/Metal path. Outer wall time was 2.929 seconds. All 32 saved stage buffers rechecked against both retained actual Go/original traces, with 26 ordinary fixture diagnostics and six explicitly limited fixtures. The added square-normal case had all three tiny quotients flushed to zero: its exact quotient was about `9.699e-39`, and GPU output zero differed from Go/original output about `4.966e-36`. All three lanes were correctly limited. The old predicate failure and historical 31-case reports remain unchanged.

Maximum normalized-feature output differences across this expanded corpus were `3.814697265625e-6` against Go and `7.62939453125e-6` against original PyTorch. The new gamma 32/high-dynamic case determines these maxima. Bounds were not widened. All outputs were finite and stage canaries intact; 134 observed requests were bodyless local GETs. Declared application-buffer and created GPU-buffer maxima remain 10,087,808 and 1,590,784 bytes respectively; these are not total process/driver residency.

Final CPU tests passed 14 distinct cases. The 33-case normalization-only Go race export passed, the original one-thread PyTorch class export passed with zero neural forward passes, and scoped golangci-lint 2.15 passed. All previous 32 files in both reference sets stayed byte-identical. Independent source/result review remains pending; no attention/model or public activation follows from this checkpoint.

A separate device-boundary regression exposed a raw-size admission underestimate. The guard now requires 1040 bytes for workgroup storage: 1024 bytes for the reduction array plus 16 for the independently rounded divisor, following the [WebGPU pipeline validation rules](https://www.w3.org/TR/webgpu/). The 1028-byte boundary failed before correction. Final 14 CPU tests pass, and admission replay of all 32 captured device limits passes with their actual 16,384-byte limit. This tightens only device admission; shader, stage arithmetic, captured data and numerical bounds remain unchanged.
