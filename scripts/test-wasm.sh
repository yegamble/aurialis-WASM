#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -s public/wasm/aurialis-dsp.wasm
test -s public/wasm/aurialis-realtime.wasm
fixture="$(mktemp)"
adaa_fixture="$(mktemp)"
trap 'rm -f "$fixture" "$adaa_fixture"' EXIT
AURIALIS_PARITY_FIXTURE="$fixture" AURIALIS_ADAA_BASELINE_FIXTURE="$adaa_fixture" \
  go test ./wasm/dsp -run 'TestWrite(NativeParity|ADAABaseline)Fixture$' -count=1
node wasm/dsp/verify.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture"
node wasm/dsp/verify.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$adaa_fixture"
node wasm/dsp/verify-live.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture" "$adaa_fixture"
node wasm/dsp/verify-realtime.mjs public/wasm/aurialis-realtime.wasm "$fixture" "$adaa_fixture"
