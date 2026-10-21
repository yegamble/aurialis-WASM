#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -s public/wasm/aurialis-dsp.wasm
fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
AURIALIS_PARITY_FIXTURE="$fixture" go test ./wasm/dsp -run TestWriteNativeParityFixture -count=1
node wasm/dsp/verify.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture"
