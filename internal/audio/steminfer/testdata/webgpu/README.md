# Private WebGPU kernel qualification
<!-- cspell:words WGSL stemyla GEMM readback s64 i64 i128x64 v64 rmsnorm softmax elementwise -->

This directory contains development fixtures only. It has no app entrypoint, public ABI, model loader or model assets. All operands and outputs stay on the device. The source inventory is pinned to the MIT-licensed stemyla commit in `source-manifest.json`; the full notice is in `LICENSE`.

The recovered tree contains seven WGSL source/templates. The Rust generator produces four matrix variants and fused attention; normalization, softmax and the elementwise module make eight modules and eleven compute entrypoints. The initial bridge is restricted to the unmodified scalar `s64` matrix kernel: contiguous F32 operands, `inner=1`, `alpha=1` and `flags=0`. Bias, accumulation and activation remain unreachable.

The proposed worker admits one fixture at a time, with a 16 MiB bound on declared CPU/GPU buffers including staging and readback copies. Shape arithmetic, operand magnitudes, finite values, device limits, cancellation and disposal require checks before any inference experiment. A capability report must record the observed adapter, features and limits, and identify reported software or fallback adapters. Browser support alone does not prove hardware execution.

Conformance must use exact transferred F32 inputs, an independent Float64 dot and a separately rounded F32 diagnostic. Bounds scale with the dot length and sum of absolute products, including cancellation and subnormal diagnostics. A kernel result does not qualify the entire model. The pinned full 882,000-sample context, all keys, original weights, normalization epsilon and five heads remain mandatory for any later model experiment.
