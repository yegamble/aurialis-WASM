# Private full-key attention CPU fixtures
<!-- cspell:words SDPA unfused softmax einsum WGSL readback GOMAXPROCS VECLIB OPENBLAS BLAS Solovyev -->

This development slice records synthetic post-RoPE, single-head attention inputs and actual native/original CPU outputs. It enables no application route, model selection, Worker or GPU dispatch. Its source branch remains based on frozen `d705f6d`; newer main documentation is not replaced or relabeled by this private checkpoint.

The 28 preregistered cases use queries `[m,64]` with `1 <= m <= 8` and keys/values `[N,64]` with `1 <= N <= 1723`. Every query attends to all keys. Ragged boundaries, full-key tails, ties, cancellation, high dynamic range, directed-rounding boundaries, subnormal inputs and FTZ resurrection are separate cases. The ceiling is 32 cases and 64 MiB of new producer/reference/log output.

## Actual references and separate probes

`attention_fixture_test.go` calls the unchanged native `multiply`, `attentionSoftmax` and `multiply` functions. The observed backend was Apple Accelerate. Source arrays, raw QK, final probabilities and PV output are saved. It loads no model, weights or audio. Native fused softmax internals are not exposed or imitated.

`attention_oracle.py` executes the exact MIT original `Attend` module at commit `6fdad13686bb7e84d029ec66f9dbe76e65c93ebf`, SHA-256 `c7abbc40a3fd20ff7f6001fa9f8ee9ad5df6452272712a5e719b8f8468bf2223` (4,410 bytes). See the package LICENSE/NOTICE. The recorder separately calls its evaluation-mode math endpoint and CPU SDPA endpoint with no dropout. Read-only observers capture the actual math endpoint's einsum and dropout input. Eight additional explicit PyTorch operations are labeled unfused probes: raw QK, multiplication by 1/8, maximum, subtraction, exponential, positive denominator, division and PV. They are not claimed to expose SDPA or fused softmax internals. No checkpoint deserialization is needed.

The original source remains a checksum-pinned, developer-supplied input, recovered from [the pinned upstream file](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/6fdad13686bb7e84d029ec66f9dbe76e65c93ebf/models/bs_roformer/attend.py). The current code retains Roman Solovyev's MIT attribution.

## Numeric design and limits

The [dated WGSL specification](https://www.w3.org/TR/2026/CRD-WGSL-20261021/#floating-point-accuracy) permits directed rounding, reassociation and arithmetic input/output FTZ. The new contract uses the full adjacent Float32 interval, not a nearest-only half-ULP assumption. Its dot diagnostic includes its own conservative Float64 accumulation error and a directed-rounding `2^-23` budget. Compensated Float64 is not an exact-real oracle. A positive-series exponential enclosure uses outward Float64 steps, 18 terms and at most 15 squaring steps, rather than treating `Math.exp` as exact. GPU exponential/division design envelopes use the specification's argument-dependent ULP budgets.

`classifyStages` recomputes raw dots and each unfused stage from exact submitted operands/previous stored stages. File-provided error budgets or sum-of-absolute-products do not exist. Stage corruption is rejected. Saved native/original endpoints remain separate diagnostics, never bound authority. Whole-file SHA-256 checks bind their provenance. Source underflow is retained even when an observed value is zero. A dyadic-grid test also limits potentially subnormal dot partial sums. End-to-end propagated uncertainty and independent proof of every reassociation remain further review work.

The mandatory case has four query lanes of 16, tail key lanes of -10.9375 and tail values of 32. Raw QK is -700; the scaled tail is -87.5. Actual CPU probes record exp/probability `9.982351397596697e-39` and final `3.194352447230943e-37`. Actual native Go, original math and CPU SDPA produce that final value too. The fixture is always underflow-limited: a legal GPU flush could remove a subnormal probability that later produces normal output. Fabricated unit traces with zeroed exponential/probability/output remain limited.

## Prospective resource plan

The 16 MiB application-buffer cap is a declared future ownership envelope, not measured GPU/driver residency. Let `C=m*N`, `O=64*m`, `I=O+128*N`, `S=5*C+2*m+O`, and `F=24+4*(I+9*C+4*O+2*m)`. Charged bytes are `5*F + 4*(4*I) + 10*(4*S) + 65,536 + 524,288`: file snapshots/checksum/transfer, input staging, stage/readback/interval copies and fixed capture overhead. The maximum is 13,848,280 bytes. A later Worker must prove this lifecycle, canaries, disposal, no queue, cancellation and device limits before hardware execution.

CPU reference work uses coarse product-term and stage-element visits: `2*m*N*64 + 12*C + 2048*m`, maximum 1,946,144 under 2,097,152. Compensated reduction and fixed series operations cost more machine instructions; payload validation visits are separately disclosed by `payloadScanFloatCount`. This is not a CPU timing guarantee.

GPU work counts scalar arithmetic/comparison operations, including padded invocations, with multiply-add terms charged twice. Let `P64=64*ceil(N/64)` and `P256=256*ceil(N/256)`:

| Planned observable pass | Charged work |
| --- | --- |
| Raw QK | `2*m*P64*64` |
| Scale | `m*P64` |
| Maximum | `m*(P256+255)` |
| Shift | `m*P64` |
| Exponential | `m*P64` |
| Denominator | `m*(P256+255)` |
| Probability | `m*P64` |
| PV | `2*m*64*N` |

The total maximum is 3,621,872 under 8,388,608. Actual-M dispatch is required; the old 64-row GEMM pair would charge 14,155,776 slots even before the other stages. No attention shader or dispatch has yet demonstrated this plan.

## Recorded CPU checkpoint

The actual exporters and independent CPU auditor exited zero in 5.684 seconds total. Go/original/auditor outer times were 3.871/1.551/0.260 seconds, with sampled aggregate child RSS 142,737,408/210,763,776/73,891,840 bytes. Limits were 30 seconds per process, two minutes total, 1 GiB sampled child RSS and 64 MiB new output; no limit was exceeded. Original PyTorch 2.8.0 used one intra/inter-op thread. Native policy was configured with `GOMAXPROCS=1`, `VECLIB_MAXIMUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1` and `OMP_NUM_THREADS=1`; opaque BLAS worker count was not observed. Its upstream deprecated SDPA-context warning is retained.

All 28 actual endpoint/probe fixtures passed the CPU stage audit: 25 ordinary-input diagnostics and three underflow-limited cases. Maximum actual Go-versus-original-math and CPU-SDPA-versus-math differences were each `1.71661376953125e-5`; unfused-probe-versus-math maximum was `1.52587890625e-5`. These are distinct observations, not a universal endpoint parity tolerance. Eight Node contract tests and the Go registry check passed. Raw sources, traces, source checksums, monitor logs and per-case plans remain in ignored `artifacts/private-stems/recovery-20261023/attention-cpu-20261023-v1/`.

GPU ownership/dispatch and full propagated-stage proof remain open. No model forward, audio processing, GPU operation, public activation or complete attention qualification is claimed. Earlier 70-case GEMM, 32-case normalization, watchdog/software-adapter failures and musical/model-conditioning limitations remain unchanged historical evidence.
