# Build and develop Aurialis
<!-- cspell:words buildmode trimpath cpqp -->

[Documentation](README.md) · [First-master guide](getting-started.md) · [Architecture](architecture.md) · [API](api.md)

This guide covers the source build, server configuration and verification commands. For repository rules and agent responsibilities, read [`AGENTS.md`](../AGENTS.md). Commands below describe how to run checks; their presence is not a claim that they passed for your checkout.

## Check your tools

Use **Node.js `26.12.0`**, **pnpm `10.33.0`** and **Go `1.26.10`**, with Git and a Bash-compatible shell. The version pins are in [`.mise.toml`](../.mise.toml), [`.nvmrc`](../.nvmrc), [`package.json`](../package.json) and [`go.mod`](../go.mod). If you already use mise, `mise install` reads the repository's tool configuration.

```bash
node --version
pnpm --version
go version
```

Check that these print the pinned versions before proceeding. A version manager may select a different Node in a non-interactive shell; ensure the intended executable is on `PATH`. Use pnpm for dependency commands and keep `pnpm-lock.yaml`; do not create other package-manager lockfiles.

## Build, verify and run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:binary
pnpm run test:binary
./aurialis
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080) in a browser on the same computer. Stop the server with Ctrl+C. `pnpm start` is an alias for running the already-built `./aurialis` executable.

[`scripts/build.sh`](../scripts/build.sh) performs these steps in order:

1. Compile the legacy offline `js/wasm` DSP module and the live `wasip1/wasm` reactor from `wasm/dsp`.
2. Copy the matching Go `wasm_exec.js` runtime for the offline module.
3. Run the Next.js static build and synchronize it into `internal/webui/embedded`.
4. Compile `cmd/aurialis`, embedding the frontend, fonts, worklets and WASM modules in `aurialis`.

Node, pnpm and Go are build tools; the resulting host executable does not need them at runtime. Build for the host you intend to run on; this guide does not establish a tested operating-system support matrix. Generated assets are not committed. **A plain `go build` or `pnpm run build` alone is not the full application build.** Rebuild all assets together when changing the frontend, worklet or WASM contracts.

`test:binary` starts the executable from an empty temporary directory and checks embedded assets, headers and API behavior. It cannot certify physical-device audio or real-time performance. See [`scripts/smoke-binary.mjs`](../scripts/smoke-binary.mjs) for its exact coverage.

## Work on the application

```bash
pnpm dev
```

This rebuilds the full application, then starts its Go server at [http://127.0.0.1:3000](http://127.0.0.1:3000). **Restart after source changes; this command has no hot reload.** Running Next.js by itself does not provide the Go processing API or the integrated server's security headers.

## Configure the local server

The executable accepts only loopback IP addresses. It has no supported public or LAN listening mode, and its request checks are not a multi-user authentication system.

| Flag | Default | Environment variable | Behavior |
| --- | --- | --- | --- |
| `-addr` | `127.0.0.1:8080` | `AURIALIS_ADDR`, then `PORT` | First nonempty environment value overrides the flag. A numeric `PORT` becomes `127.0.0.1:<port>`; an address must use a loopback IP. |
| `-workers` | `0` (automatic) | None | Automatic starts the smaller of two workers or the available logical CPU count; explicit worker counts are capped at four. This configures background analysis jobs, not simultaneous synchronous renders. |
| `-max-upload-bytes` | `269484032` (257 MiB) | `MAX_UPLOAD_BYTES_OVERRIDE` | Caps the entire multipart request, including overhead. A positive integer environment value overrides the flag. The resolved value must be between 1 and the hard 257 MiB ceiling. |

For example, when address environment overrides are unset:

```bash
./aurialis -addr 127.0.0.1:8081 -workers 2
```

Open `http://127.0.0.1:8081` for that example. `pnpm dev` sets `AURIALIS_ADDR` to `127.0.0.1:3000` unless it is already set. An existing `AURIALIS_ADDR` or `PORT` can also change the normal executable's address; check the startup message for the effective URL.

The browser file limit is 268,435,500 bytes (256 MiB + 44), with 33,554,432 decoded frames. Lowering the request ceiling can reject a file that passes browser preflight. Increasing it beyond the hard cap fails startup. One expensive audio POST runs at a time; a second receives retryable `503` with `Retry-After: 1`. See [the API resource contract](api.md#security-and-resource-contract) for decoding, job memory, timeouts and retention.

## Verify changes

Run the gates applicable to the change with the pinned tools on `PATH`. [`AGENTS.md`](../AGENTS.md) defines the mandatory verification policy; [CI](../.github/workflows/ci.yml) defines its automated execution. Some checks require additional developer tools: `golangci-lint`, `identypo`, `govulncheck`, Python 3, FFmpeg and Playwright's browser installation. FFmpeg is an independent meter-verification tool, not an application runtime dependency.

Linux CI installs the pinned Playwright release's full Chromium OS package list on every browser runner, with a five-minute provisioning limit. Browser binaries are restored separately; a cache miss downloads Chromium within a four-minute step. [`ci-ubuntu-apt.sh`](../scripts/ci-ubuntu-apt.sh) is a CI-only privileged helper: it sets two APT acquisition retries and 30-second HTTP/HTTPS timeouts globally so Playwright's privileged child inherits them, and switches only the known Azure Ubuntu archive URL to Ubuntu's official HTTPS archive. Signature checks remain enabled. The helper is not a macOS development command. A provisioning failure fails the gate; it never skips browser tests or relaxes assertions.

The shared-settings browser test drains two newly observed audio buffers after acknowledgment, then compares one-second destination energy directly at the original 0.12 dB bound. Its real 0.95-volume control must detect the known gain change and restoration. Energy-completion polling runs every 50 ms without changing the frame count or timeout. Raw windows, failed before/after pairs and JSON-safe diagnostics are retained; the earlier remote failure's exact cause is not inferred from subsequent passing runs.

### Go and compiled WASM

```bash
"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm
go mod verify
go vet ./...
golangci-lint run ./...
identypo ./...
govulncheck ./...
go test -race -count=1 ./...
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o public/wasm/aurialis-realtime.wasm ./wasm/dsp
```

The formatting command should print nothing. Invoke the formatter through Go's actual path to avoid local aliases that might edit files.

### Frontend and audio bridges

```bash
pnpm exec tsc --noEmit
pnpm run lint
pnpm exec knip
pnpm exec cspell lint "**/*.{ts,tsx,go,md}"
pnpm test
pnpm run build
pnpm run test:wasm
pnpm run test:meters
```

### Integrated application and repository hygiene

```bash
pnpm run build:binary
pnpm run test:binary
pnpm run test:backend:postman
pnpm exec playwright test
python3 scripts/sync-agents.py --check
```

The Newman runner and Playwright configuration manage their test servers. Review their configuration before running concurrent suites; stop only processes you started. If Playwright browsers are missing, install the configured Chromium browser with `pnpm exec playwright install chromium` and provide any required system dependencies.

The Linux Firefox engine-matrix job owns a PulseAudio null sink under `RUNNER_TEMP` and runs a bounded real `AudioContext` resume/clock probe before and after provisioning. Its diagnostics and sink metadata are retained with the browser artifacts, and cleanup runs after the probe. This checks the CI audio environment; it does not relax the product playback assertions. The hosted rerun after this change is still pending.

Record which checks actually ran, their exit status, the source revision and their scope. Unit, WASM bridge, API, browser and compiled-binary evidence establish different things. Passing a smoke test does not establish hardware fidelity, platform certification, universal browser support or every accessibility interaction. Historical results and unresolved requirements belong in [tasks](tasks.md) and [the ledger](../.claude/war-room/ledger.md).

## How CI reuses builds and runs checks

[The CI workflow](../.github/workflows/ci.yml) runs on pull requests targeting `main`, pushes to `main`, and manual dispatch. A feature-branch push does not also start a duplicate run; open or update its pull request to run CI.

| Required check | Work it requires |
| --- | --- |
| War Room, Stack & Workflow Hygiene | Repository rules, agent synchronization, artifact boundary and QA cleanup tests, SHA-pinned actions with no `@latest`, workflow lint |
| Go 1.26 & WASM Quality Gate | Separate static/security and race/meter VMs, plus actual compiled WASM/automation parity; every result must succeed |
| Next.js 16, TypeScript & Bundle Gate | Full dependency audit, all frontend checks and units, one native-target Next/dual-WASM/production build, binary smoke and a separate QA executable |
| Backend API & Postman/Newman Gate | Fresh complete API/security probes against the verified production executable |
| Playwright Responsive (320px-1440px) & WCAG 2.2 AA Gate | All individual native tests distributed across three Chromium VMs, plus a separate static browser/local-audio run; one worker each, zero retries |
| CI Passed | All five checks above must succeed; failed, cancelled or skipped dependencies fail this gate |

The native build job publishes one immutable same-run artifact: the production executable, separate QA executable, both WASM modules and matching Go JavaScript runtime. The QA variant includes the static test observer; production smoke requires its URL to return 404. `scripts/ci-artifacts.py` checks the complete file list, sizes, hashes and modes before restoring files. It rejects links and binds the artifact to the checkout, source bytes, pull-request head, workflow run, producer attempt, platform and execution target. A failed-job rerun can select its earlier successful producer attempt from the same run. A different checkout or target requires its own build; native UI assets cannot substitute for a browser-execution build.

A separate browser producer runs `build:browser` once with the browser execution flag and a distinct Next/Go cache. `ci-browser-artifacts.py` packs a closed browser profile: asset archive, exact per-file manifest and generated static policy. It binds the same source/run/attempt facts as the native artifact, rejects native substitution, unsafe paths, links, duplicate members and altered bytes, and enforces per-file/package limits. The static test VM restores that artifact rather than rebuilding. Both closed profiles have local complete removal/restoration evidence at `cd0e404`; the browser run used its restored asset tree. These local receipts retain their original head/source facts after later documentation changes. Final-head CI produces fresh receipts, as described in [the browser verification record](browser-local.md#verification-status). `serve-browser.sh` verifies its receipt before Wrangler when `AURIALIS_USE_CI_BROWSER_ASSETS=1`; invalid modes or receipts fail before launch. Local development still uses its existing generated assets. The static browser consumer shares the merged CI-only Ubuntu mirror/timeout helper, always installs the required OS packages within five minutes, and downloads Chromium only on a cache miss within a separate four-minute step. It does not add another browser-cache writer.

**Test results are never cached.** API, signal and browser assertions execute again after artifact validation. Each browser shard retains its JSON report and PCM evidence. Individual tests are distributed with `fullyParallel: true`; `workers: 1` still permits only one test at a time on each VM. Tests use independent browser contexts and test-specific output paths, with no shared setup or serial groups. The native suite’s 12-minute global test limit leaves room within the 20-minute job for setup and report upload; individual test timeouts and zero-retry policy remain unchanged. The separate static suite has a nine-minute global test limit within its 20-minute job, with 60-second cases, one worker and zero retries. Local runners keep their normal fresh-build behavior. The prebuilt environment switches are reserved for validated CI artifacts.

Caches speed dependency setup or compilation. pnpm caches its package store; Next caches `.next/cache` by dependencies, configuration and source. [The shared Go setup](../.github/actions/setup-go/action.yml) caches only compiled objects, with keys for job role, OS/architecture, runner image, Go version, `go.mod` and Go source. The producer adds its embedded frontend source hash. Every browser shard has its own role so concurrent jobs can save their own compiler outputs. Changed source can restore the same role's earlier compatible objects; Go still checks content and fresh tests use `-count=1`. This standard-library-only repository does not cache downloaded Go modules.

Chromium uses OS/architecture, Playwright version and lockfile keys. All shards may restore it, but only shard 1 saves a missing browser cache. Linux OS dependencies install on both hits and misses. [Next documents its build cache](https://nextjs.org/docs/app/guides/ci-build-caching); [Playwright warns](https://playwright.dev/docs/ci#caching-browsers) that browser-cache restoration can cost about as much as downloading, so its benefit requires measurement.

For focused script checks:

```bash
python3 scripts/test-ci-artifacts.py
python3 scripts/test-ci-browser-artifacts.py
python3 scripts/test-e2e-build.py
```

[The task record](tasks.md#ci-build-reuse-and-isolated-checks) distinguishes local build-consumer proof from the required final-head Linux run. Fresh checks remain mandatory before merge; build reuse does not certify product completeness or audio deadlines.

### Supply-chain and out-of-band checks

- **Pinned actions.** Every third-party `uses:` in `.github/workflows/` and `.github/actions/` names a full 40-character commit SHA followed by a `# vX.Y.Z` comment; `docker://` images need an `@sha256:` digest. The hygiene job runs [`check-workflow-pins.py`](../.github/scripts/check-workflow-pins.py), which also rejects `@latest` anywhere in those files. Run it locally with `python3 .github/scripts/check-workflow-pins.py`.
- **Pinned tools.** CI runs govulncheck `v1.9.0` and identypo at commit `dcb8a7984045` (no tagged releases; its two dependencies, misspell and camelcase, still resolve to their latest versions at run time). actionlint 1.7.12 is downloaded as a release tarball and checked against a pinned SHA-256 before it runs.
- **Dependency audit.** The frontend job runs `pnpm audit --audit-level high` after install. It audits the whole lockfile, development tools included: Wrangler runs with the Cloudflare deploy token, and Vitest and Newman run in CI. Any high or critical advisory fails the job unless its GHSA ID is listed in `pnpm.auditConfig.ignoreGhsas` in `package.json`. Range-scoped `pnpm.overrides` in `package.json` lift vulnerable transitive versions to same-major fixes: `handlebars`, `lodash`, `node-forge`, `qs` and `underscore` under Newman, and `flatted` under the linters' `flat-cache`. Two high advisories are ignored, both reached only through Newman (`postman-runtime` and `postman-collection`), which runs our own checked-in collection against a local test binary:
  - `GHSA-qxc2-j82w-r537`, `@faker-js/faker` 5.5.3: code execution through `helpers.fake` with attacker-controlled templates. The only fix is faker 10.5.0, five majors past what Postman pins, and forcing it would likely break Postman's dynamic variables. Our collection is trusted input. Remove the ignore when Newman ships a fixed faker.
  - `GHSA-86w9-cpqp-85rv`, `node-forge` 1.4.0: RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements. No fixed release exists (all versions up to 1.4.0 are affected). The Newman suite does no certificate or signature verification against untrusted parties. Remove the ignore when a fixed `node-forge` is published.
- **Dependabot.** Dependabot security updates are enabled in repository settings; version updates follow the weekly schedule in [`.github/dependabot.yml`](../.github/dependabot.yml) for Go modules, pnpm and GitHub Actions. Minor and patch version updates arrive as one grouped pull request per ecosystem; major updates open separately.
- **Smart Split model asset.** [`model-asset.yml`](../.github/workflows/model-asset.yml) runs daily, on manual dispatch and on pull requests that change the steminfer model pins or the check itself. [`check-model-asset.sh`](../.github/scripts/check-model-asset.sh) reads the URL, byte size and SHA-256 from the Go source, requires an HTTP 200 HEAD with the pinned `Content-Length`, and compares GitHub's recorded asset digest with the pinned SHA-256 without downloading the model.
- **macOS Accelerate kernels.** [`steminfer-macos.yml`](../.github/workflows/steminfer-macos.yml) runs `go test -race` on `./internal/audio/steminfer/...` on `macos-latest` with cgo, after confirming that `matrix_accelerate.go` and `nonlinear_accelerate.go` are compiled. It runs on every push to `main`, on dispatch, and on pull requests that touch steminfer, `go.mod`/`go.sum` or the Go setup action. Because pull requests can skip it, it must not be made a required check.

- **Native inference qualification.** [`steminfer-native.yml`](../.github/workflows/steminfer-native.yml) supports manual Linux/Windows/Intel model accuracy, heap, cancellation and actual two-window reconstruction checks. Only Linux/Windows have the 180-second model-window gate; Intel timing is observational. It also runs on the implementation branch, skipping branch deletion.
- **Intel numerical reference.** [`steminfer-intel-numerics.yml`](../.github/workflows/steminfer-intel-numerics.yml) supports manual synthetic matrix/transformer checks against an independent float64 reference, forward-error bounds and bit-exact grouping/parallel controls. It runs without model downloads or private audio, also on its implementation branch, and skips branch deletion.

## Contribute with the specialist agents

Work on a short-lived branch and keep changes in small, readable commits. Synchronize affected documentation with the technical writer before closing a change. For a complete agent roster and review modes, see [the War Room guide](../.claude/agents/README.md) and [protocol](../.claude/war-room/protocol.md).

```text
/war-room feature=deep-mastering
/war-room ci-cd
/war-room-loop feature=wasm-dsp max-iterations=4 merge=owner
```

`/war-room` reviews and rules on a scope; `/war-room-loop` also implements and verifies it. When changing canonical agent definitions under `.claude/agents/`, synchronize their generated definitions:

```bash
python3 scripts/sync-agents.py
python3 scripts/sync-agents.py --check
```

Treat planned capabilities in design documents as requirements, not implemented behavior. Report work as **open — awaiting merge** until the repository's required review, verification and merge conditions are met.

## Protected main branch

Main requires a pull request, an up-to-date branch, all six repository CI checks and GitGuardian, and resolved conversations. The rules apply to administrators and prohibit force pushes and deletion. Required human approvals are zero so the authorized delegated review and merge workflow can proceed after its specialist gates.
