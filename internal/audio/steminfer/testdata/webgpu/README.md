# Private WebGPU kernel qualification
<!-- cspell:words WGSL stemyla GEMM readback SwiftShader SwANGLE steminfer testdata webgpu s64 i64 i128x64 v64 rmsnorm softmax elementwise -->

This directory contains development fixtures only. It has no app entrypoint, public ABI, model loader or model assets. All operands and outputs stay on the device. The source inventory is pinned to the MIT-licensed stemyla commit in `source-manifest.json`; the full notice is in `LICENSE`.

The recovered tree contains seven WGSL source/templates. The Rust generator produces four matrix variants and fused attention; normalization, softmax and the elementwise module make eight modules and eleven compute entrypoints. The initial bridge is restricted to the unmodified scalar `s64` matrix kernel: contiguous F32 operands, `inner=1`, `alpha=1` and `flags=0`. Bias, accumulation and activation remain unreachable.

The proposed worker admits one fixture at a time, with a 16 MiB bound on declared CPU/GPU buffers including staging and readback copies. Shape arithmetic, operand magnitudes, finite values, device limits, cancellation and disposal require checks before any inference experiment. A capability report must record the observed adapter, features and limits, and identify reported software or fallback adapters. Browser support alone does not prove hardware execution.

Conformance must use exact transferred F32 inputs, an independent Float64 dot and a separately rounded F32 diagnostic. Bounds scale with the dot length and sum of absolute products, including cancellation and subnormal diagnostics. A kernel result does not qualify the entire model. The pinned full 882,000-sample context, all keys, original weights, normalization epsilon and five heads remain mandatory for any later model experiment.

## Preparing a local probe

Run each command from the repository root. `FRESH_*` paths must not exist; use an ignored private research directory. The Go exporter writes 70 small deterministic cases, including tile tails, zero, cancellation, large/small and subnormal values. It uses exact F32 operands, compensated Float64 references and a separately rounded Float32 dot.

```sh
go run internal/audio/steminfer/testdata/webgpu/fixtures.go FRESH_FIXTURE_DIRECTORY
node internal/audio/steminfer/testdata/webgpu/verify_fixture_references.mjs FRESH_FIXTURE_DIRECTORY
python3 -B internal/audio/steminfer/testdata/webgpu/prepare_harness.py --out FRESH_HARNESS_DIRECTORY
python3 -B internal/audio/steminfer/testdata/webgpu/serve_harness.py --root FRESH_HARNESS_DIRECTORY --port 3938
```

Open `http://127.0.0.1:3938` in the browser selected for qualification. Inspect the adapter first. Select local `.bin` fixture files with the file picker; their bytes are never submitted over HTTP. The server exposes only its closed static code list. The worker imports a generated literal of the exact pinned shader and verifies its SHA-256 before compilation.

The client snapshots comparison data privately before awaiting a result. It then recomputes the Float64 dot and sum of absolute products from the exact submitted F32 operands; edited file references cannot enlarge the acceptance bound. Normal rounding and separately diagnosed subnormal flushing have distinct outcomes. The current limits are 2,048 per dimension, 2,097,152 actual reference multiply-adds, 8,388,608 padded GPU multiply-adds and 16 MiB of declared application buffers, including the private snapshot. Opaque browser/driver/device overhead is outside that buffer count.

Each request owns a fresh worker/device and admits no waiting request. Cancellation requests explicit GPU-buffer/device destruction and allows 50 ms for cleanup before hard termination. The normal watchdog is five seconds plus that cleanup grace. Cleanup does not guarantee prompt GPU preemption. Success still requires actual adapter evidence, finite results, intact output canaries, exact source/ABI identity and the declared component checks.

## Evidence status

Source recovery and 13 CPU-only contract/mock-worker checks passed. The Go exporter produced 70 fixtures (3,285,160 bytes total), and an independent JS recomputation verified every saved Float64 reference, sum of absolute products and rounded Float32 diagnostic. These are reference checks, without GPU execution.

The default headless Chromium `156.0.8078.4` capability probe returned **no WebGPU adapter**. Its browser system report identified SwANGLE/SwiftShader Vulkan software rendering and `webgpu: unavailable_software`. No extra GPU flags were requested. The browser and loopback server were closed; no kernel or model ran. The retained capability artifact is `artifacts/private-stems/recovery-20261023/webgpu-capability-default.json`. Hardware identity, GPU fixture conformance and all full-model browser/resource/quality gates remain **unqualified**. The first nested mocked-deadline check was interrupted while awaiting a timer; advancing the mocked deadline and cleanup grace separately corrected the test clock without changing assertions.
