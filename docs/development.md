# Build and develop Aurialis
<!-- cspell:words buildmode trimpath -->

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
| `-max-upload-bytes` | `135266304` (129 MiB) | `MAX_UPLOAD_BYTES_OVERRIDE` | Caps the entire multipart request, including overhead. A positive integer environment value overrides the flag. The resolved value must be between 1 and the hard 129 MiB ceiling. |

For example, when address environment overrides are unset:

```bash
./aurialis -addr 127.0.0.1:8081 -workers 2
```

Open `http://127.0.0.1:8081` for that example. `pnpm dev` sets `AURIALIS_ADDR` to `127.0.0.1:3000` unless it is already set. An existing `AURIALIS_ADDR` or `PORT` can also change the normal executable's address; check the startup message for the effective URL.

The browser file limit remains 134,217,772 bytes (128 MiB + 44), with 16,777,216 decoded frames. Lowering the request ceiling can reject a file that passes browser preflight. Increasing it beyond the hard cap fails startup. One expensive audio POST runs at a time; a second receives retryable `503` with `Retry-After: 1`. See [the API resource contract](api.md#security-and-resource-contract) for decoding, job memory, timeouts and retention.

## Verify changes

Run the gates applicable to the change with the pinned tools on `PATH`. [`AGENTS.md`](../AGENTS.md) defines the mandatory verification policy; [CI](../.github/workflows/ci.yml) defines its automated execution. Some checks require additional developer tools: `golangci-lint`, `identypo`, `govulncheck`, Python 3, FFmpeg and Playwright's browser installation. FFmpeg is an independent meter-verification tool, not an application runtime dependency.

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

Record which checks actually ran, their exit status, the source revision and their scope. Unit, WASM bridge, API, browser and compiled-binary evidence establish different things. Passing a smoke test does not establish hardware fidelity, platform certification, universal browser support or every accessibility interaction. Historical results and unresolved requirements belong in [tasks](tasks.md) and [the ledger](../.claude/war-room/ledger.md).

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
