# Private paired-module screening source
<!-- cspell:words testdata untimed -->

This is an unexecuted source checkpoint. It does not select the exact-extrema candidate, change public algorithm availability or waive the 192 kHz deadline. The prior 104-file GoJS evidence index remains immutable.

The producer adds exactly one opt-in Go test to qualified `e492156` source. Every other tracked Go file and `go.mod` must match that commit. The original and candidate use the exact accepted 14/6-entry overlays, excluding the same six frozen AR files. Both modules receive identical test source. The producer hashes the complete effective source sets, all runner sources, compiler environment, modules and pinned GoJS runtime. Builds have a 25-second process-group watchdog and explicit failure receipts.

Before timing, the new modules must each reproduce their corresponding archived 192 kHz recorder stream once. The second workload rechecks those retained bytes and hash-bound receipts without rerunning the recorder. Separate untimed children then compare 32 verification blocks after 64 warm blocks. A qualification receipt binds the actual bytes to the new modules. Each measurement child repeats that verification, resets the graph, warms 64 blocks and measures exactly 32 further 128-frame calls. Its actual PCM and numeric-state digest must equal its own verification after reset. The parent also requires cross-module verification and measured PCM/state equality before interpreting durations or allocation observations.

The initial closed scope is 192 kHz, Tube, default Optical compressor, the published active settings with 12 dB makeup and 24-bit dither, and two prepared sources. `steady` is the previously published repeated 128-frame source; `peaky` adds explicit hot transients. Neither source is a musical corpus. The peaky input is not claimed band-limited. Prepared source samples and full settings are retained in every stream.

Both finite and repeat configurations declare 16,777,216 source frames. Each post-reset history reaches only frame 12,288. No declared source wrap or EOF is reached, and no drain occurs. This is configuration screening before those boundaries. Existing independent wrap/EOF/drain/alias/identity gates remain necessary. The 8,192-frame warm interval is not claimed physical steady state. Frozen copies of the extra Go test use a `.go.source` suffix, preserving the exact ignored-Go admission inventory.

Every verify child processes 24,576 base frames; every measure child processes 49,152, including both modes and all warm, verification, reset-warm and timed calls. A baseline-before/candidate/baseline-after triplet processes 147,456 base frames and at most 589,824 high-planner frames. The existing per-child caps remain 200,000/800,000 frames, 16 Mi numeric words and 8 MiB output. Each child has a 25-second Go watchdog and 28-second external process-group watchdog. Output writes, logs, operations, descriptors and receipts reuse the qualified closed filesystem caps. Test-owned values are admitted below 8 MiB; Go/V8 RSS, GC and runtime memory are not bounded by that statement.

No constructor, state traversal, hashing, encoding or file IO occurs in the timed loop. The loop directly calls the existing graph into preallocated output slices and checks returned frame counts. Two clock calls bracket the batch; runtime allocation snapshots are outside that interval. The parent preserves all observed durations and fails on nonzero allocation observations. No overhead is subtracted. Separate fresh pinned Node processes exclude startup from the interval, but do not eliminate host or JIT drift. Before/after controls remain visible. A 32-block batch mean is not a worst-callback or browser continuity certificate, and no new headroom threshold is adopted.

Only after separate source/build approval and an explicitly coordinated quiet release may the following commands run:

```text
python3 internal/audio/dsp/testdata/extrema_screen/producer.py build NEW_BUILD_ID
python3 internal/audio/dsp/testdata/extrema_screen/run-screen.py qualify NEW_BUILD_ID steady
python3 internal/audio/dsp/testdata/extrema_screen/run-screen.py qualify NEW_BUILD_ID peaky
python3 internal/audio/dsp/testdata/extrema_screen/run-screen.py measure NEW_BUILD_ID steady quiet-approved
python3 internal/audio/dsp/testdata/extrema_screen/run-screen.py measure NEW_BUILD_ID peaky quiet-approved
```

Every build/run directory is fresh and exclusive. A failed child stops its tranche and retains partial bytes, receipts and logs. Historical Node-exit, full-recorder race timeout, Nyquist, Newton, general AR and 192 kHz performance failures remain red. The separate 270 native/WASM state-digest differences remain unproven and are not explained or waived by this screen. No source or timer result has been executed by preparing these files.
