<!-- cspell:words swiftshader PGID PPID pidpath PYTHONDONTWRITEBYTECODE -->
# Private attention launcher — source only
<!-- cspell:words Popen yosefgamble steminfer testdata webgpu -->

This checkpoint implements normal/crash ownership controls for later review. **No actual launcher, server, browser, Worker, adapter, GPU or model ran.** Importing the modules creates none. Actual normal/crash execution needs a separate Chair release; attention hardware capture, audio, full inference and public activation remain unreleased.

## Exact reuse and local runtime facts

The sole process-group admission/signaling authority is unchanged `owned_groups.py`, SHA-256 `d5a9978835c7ebcd6fd9c30c6074f4e55b84ac26683b66c4f9198daf3dd08a40`. Exact `owned-browser.mjs` and observed-process survivor additions come from accepted `51d206c`; `provenance.json` records current origins and previous hashes. The prior sixteen process controls were not rerun. Three mocked Node admission tests ran here without an actual browser.

Read-only files identify `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`: a regular 72,544-byte entry, SHA-256 `67539969b31e7579456d87ea62d9556f928f9c92af86bb3f43fe33b57d1cfad7`, bundle short version `155.1.97.59`. These are installed-file facts, not actual renderer/adapter evidence. `attention-launch-pins.json` also binds local Node 26.12.0, Python and the existing Playwright 1.64.1 entry/package/core files. Runtime drift fails before launch; there is no installation, download, executable fallback or user-profile reuse.

## Before-work ownership

The Python parent checks actual monitoring before `Popen`; the Node child starts a new session with `--max-old-space-size=192` and `--stack-size=8192`. All post-spawn setup is inside cleanup handling. The shared Node helper first awaits exact Node and detached BrowserServer admission acknowledgements. Launch options are closed: installed Brave, `headless: false`, explicit `chromiumSandbox: true`, no custom arguments, GPU/software forcing or security-disabling flags. The parent records/checks the actual browser command and a fresh profile beneath its own scratch directory.

Only after browser admission may Node acquire its static Python server in the acknowledged Node process group. A synchronous managed host handle exists before its asynchronous spawn/readiness task. Failure or stop retains that handle until its real close settles. The parent independently verifies server PID/parent/group and exact executable/source command. A fresh work acknowledgment requires the live Node, browser and server together, checked resources and exact request identity.

After that ACK, a tiny fixed Blob Worker runs on a separate fresh `about:blank` page. It posts the number one, terminates and revokes its URL; it uses no audio, model or WebGPU API. The existing closed fourteen-asset page then loads and must remain idle with zero selected fixture files. HTTP requests are limited to literal same-origin GET/HEAD assets with empty bodies; local Blob Worker traffic is separate. CDP renderer/version observations are bounded and labeled independently. Adapter/features/limits have explicitly not been requested; CDP renderer data cannot stand in for `requestAdapter` or hardware conformance.

Normal exit does not bypass shared-helper cleanup and a final observation with no live owned processes. In crash mode, readiness follows acknowledged work; the parent deliberately kills its exact direct Node child and requires at least one exact browser-group identity admitted before that crash to survive. The accepted survivor predicate can identify a child whose parent changed when its original leader has exited. It cannot admit a new/reused/zombie identity. Cleanup signals only groups revalidated by the unchanged shared authority.

## Closed budgets and final authority

The sampled union includes the monitoring parent, Node, browser and static-server processes once: at most 4 GiB RSS, 256 live processes and 4,096 known identities. New output admission is at most 64 MiB including fresh browser profile, logs, metadata, observations and verdicts; free disk must retain 6 GiB. Profile symlinks are counted without following them, and disappearing temporary files are sampled honestly. A 25-second work-phase deadline leaves cleanup room; actual elapsed time is checked against 60 seconds. A failed or late OS settlement remains a failed control, never an invented timely cleanup guarantee. RSS/disk observations are sampled, not instantaneous universal bounds.

The guard receipt is provisional (`candidate-pass` is not success). Its serialization is capped at 8 MiB, reserved along with 4 KiB for the final verdict, closed and rehashed. Observations must show no live owned processes and resource checks must still pass. Only the bounded `final-verdict.json`, bound to that closed receipt hash, can report final success. Primary and cleanup errors are preserved separately; an unsettled or missing observation/receipt yields failure. Small fixed launcher records add no fixture-stage copies. Existing 16 MiB fixture admission, 2 KiB one-in-flight capture, four-fixture/60-second future batch ceiling, 28 pins and all numeric work caps remain unchanged; no capture mode exists in this launcher.

## Executed source controls and future commands

Seventy injected Node/source tests passed in 608.552625 milliseconds, concurrency one. Eight pure fake-row/import-sentinel Python tests passed in 0.012 seconds. Source controls cover admission before work, stop during returned-handle acquisition, delayed cleanup, primary plus aggregate cleanup errors, refused work admission, closed modes/flags, exact resource boundaries, known crash survivors and final emptiness. No actual OS group tests ran. A first Python test incorrectly expected `/tmp` rather than macOS's resolved `/private/tmp`; that test-setup RED is retained, and its corrected canonical expectation passed without changing policy.

Source-only commands (safe without a hardware release):

```sh
/Users/yosefgamble/.nvm/versions/node/v26.12.0/bin/node --test --test-concurrency=1 scripts/qualification/attention-launch.test.mjs scripts/test-owned-browser.mjs internal/audio/steminfer/testdata/webgpu/attention/*.test.mjs
python3 scripts/qualification/test_attention_contract.py
```

**Do not run the following actual ownership commands until separately released.** Each requires a new output name beneath this worktree's existing `artifacts/` directory. They are normal/crash controls, not attention fixtures:

```sh
python3 scripts/qualification/attention-parent.py --mode normal --output "$PWD/artifacts/private-stems/attention-owned-normal-UNIQUE"
python3 scripts/qualification/attention-parent.py --mode crash --output "$PWD/artifacts/private-stems/attention-owned-crash-UNIQUE"
```

The original CPU, scalar-GEMM, normalization, conditioning/quality and capture-failure proofs remain unchanged. Actual attention shader compilation/adapter identity, normal/crash process observations and 28 hardware fixture captures are all still pending; this checkpoint qualifies no model, latency, musical quality or public feature.


## Retained normal RED and explicit flag correction

The one released normal attempt at `b599aa6` failed after 1.428087584 seconds while checking the static Python server command prefix. Its raw static command was not saved, so its alias cause remains unknown. Browser argv/profile were retained; final saved live-members and all-members lists were both empty, with no cleanup errors. No work ACK, page, tiny Worker, fixture, adapter or audio work occurred. The original raw files and review index remain unchanged.

The browser command included Playwright's default `--enable-unsafe-swiftshader`. [Chromium's primary documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md) describes its software WebGL fallback/security effect; that flag does not identify an actual adapter. The new, explicitly reviewed source option ignores only this default and the command guard rejects it. The omission list is frozen; no other arguments/defaults, backend selection or sandbox options change. Contract revision two requires new normal/crash controls after review; no new actual launch occurred. Two controlled old-source REDs and the first actual RED remain preserved.


## Static Python identity diagnostic — source only

The first normal RED did not retain the rejected static command, so its exact alias remains unverified. The repaired parent now saves the bounded raw command before applying the original strict executable-prefix/source-argv rules. It brackets capture with exact PID/start/PGID/PPID observations and separately records Darwin `proc_pidpath` plus streamed file SHA-256/geometry. The [source manifest](attention-identity-sources.json) records local SDK interface hashes and [Apple's published wrapper](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/libsyscall/wrappers/libproc/libproc.c). No Apple implementation body was copied. The native API remains unexecuted in this source wave. Path/hash observations are diagnostic, not atomic running-image attestation or permission to accept an alias. Raw capture, after-identity, persistence, executable-read and descriptor-close errors are retained separately; any missing evidence fails closed.

The new `attention-python-identity.py` is a separately gated, minimal one-child runner. It uses the same pinned Python executable and exact `serve.py` argv; no Node or browser launches. An optional environment token makes `serve.py` publish a small ready marker after interpreter startup and block **before socket bind or asset loading**. This barrier accepts EOF only: no message can release work. The runner waits for that marker before OwnedGroups admission, so an interpreter launch transition is not mistaken for an admitted identity change. Before admission, the exact Popen handle remains owned and is closed/terminated/reaped on failure. After admission, unchanged group authority performs cleanup; a failed wait still attempts exact direct-child kill/reap while preserving the group refusal. No group signal rule is relaxed.

The runner records strict argv rejection honestly as evidence. Its final status is only `observed` or `fail`, with `qualification: false`; even complete capture grants no normal/crash, hardware or model acceptance. Limits remain 4 GiB sampled supervisor/child union RSS, 256 live / 4,096 known identities, 64 MiB new output including scratch, 6 GiB free reserve and 60 seconds at the last resource admission before final writes. The child ready deadline is five seconds. One raw command record is capped at 192 KiB, its command prefix at 16 KiB, kernel path at 4 KiB, and executable file scan at 64 MiB using a 64 KiB scratch read. There is no HTTP client, fixture File, adapter or audio operation. The unchanged helper's historical `node` leader key labels this direct Python child; no Node runtime is implied.

Executed source evidence: 37 injected Python cases in 0.035 seconds (8 policy, 17 identity, 12 held-runner controls); 70 injected Node/source cases in 553.35475 milliseconds, concurrency one; and three pure handler cases in 0.002 seconds. These cover raw persistence before strict refusal, before/after identity drift, unavailable/faked native API, bounded ps cleanup, simultaneous read/close failures, ready-before-admission, no release-to-bind token, admission/capture/close/group/wait failures and final live-member refusal. They use fake process/API objects and tiny private files only. Independent peer primary/close RED and corrected probe are retained alongside both old SwiftShader source REDs. No actual process diagnostic, socket, browser or GPU ran during this source wave.

Source controls:

```sh
PYTHONDONTWRITEBYTECODE=1 /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9 -m unittest discover -s scripts/qualification -p 'test_attention_*.py'
/Users/yosefgamble/.nvm/versions/node/v26.12.0/bin/node --test --test-concurrency=1 scripts/qualification/attention-launch.test.mjs scripts/test-owned-browser.mjs internal/audio/steminfer/testdata/webgpu/attention/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9 internal/audio/steminfer/testdata/webgpu/attention/test_capture_server.py
```

**Do not execute this diagnostic until separately released after source review:**

```sh
/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9 scripts/qualification/attention-python-identity.py --output "$PWD/artifacts/private-stems/attention-python-identity-UNIQUE"
```

The original normal/crash source checkpoint, first actual RED, fixture/shader bytes, intervals and all numeric budgets remain unchanged. This runner's source/pin changes require independent review before that one-child diagnostic; fresh browser normal/crash controls remain a later separate gate.
