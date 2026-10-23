#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${AURIALIS_USE_CI_ASSETS:-0}" in
  1) python3 scripts/ci-artifacts.py verify ;;
  0) ;;
  *) printf 'Invalid compiled CI asset mode\n' >&2; exit 1 ;;
esac
test -s public/wasm/aurialis-dsp.wasm
test -s public/wasm/aurialis-realtime.wasm
fixture="$(mktemp)"
adaa_fixture="$(mktemp)"
automation_fixture="$(mktemp)"
source_clock_fixture="$(mktemp)"
trap 'rm -f "$fixture" "$adaa_fixture" "$automation_fixture" "$source_clock_fixture"' EXIT
AURIALIS_PARITY_FIXTURE="$fixture" AURIALIS_ADAA_BASELINE_FIXTURE="$adaa_fixture" \
  go test ./wasm/dsp -run 'TestWrite(NativeParity|ADAABaseline)Fixture$' -count=1
node wasm/dsp/verify.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture"
node wasm/dsp/verify.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$adaa_fixture"
node wasm/dsp/verify-live.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture" "$adaa_fixture"
node wasm/dsp/verify-realtime.mjs public/wasm/aurialis-realtime.wasm "$fixture" "$adaa_fixture"

AURIALIS_AUTOMATION_FIXTURE="$automation_fixture" AURIALIS_SOURCE_CLOCK_FIXTURE="$source_clock_fixture" go test ./wasm/dsp -run 'TestWrite(AutomationParity|SourceClockParity)Fixture$' -count=1
node wasm/dsp/verify-automation.mjs public/wasm/aurialis-realtime.wasm "$automation_fixture" "$source_clock_fixture"
