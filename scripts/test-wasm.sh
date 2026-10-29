#!/usr/bin/env bash
# cspell:words trimpath
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
offline_fixture="$(mktemp)"
oversampled_fixture="$(mktemp)"
legacy_dir="$(mktemp -d)"
legacy_module="$legacy_dir/aurialis-dsp-legacy-probe.wasm"
trap 'rm -f "$fixture" "$adaa_fixture" "$automation_fixture" "$source_clock_fixture" "$offline_fixture" "$oversampled_fixture"; rm -rf "$legacy_dir"' EXIT
AURIALIS_PARITY_FIXTURE="$fixture" AURIALIS_ADAA_BASELINE_FIXTURE="$adaa_fixture" \
  go test ./wasm/dsp -run 'TestWrite(NativeParity|ADAABaseline)Fixture$' -count=1
GOOS=js GOARCH=wasm go build -tags aurialis_legacy_probe -trimpath -o "$legacy_module" ./wasm/dsp
node wasm/dsp/verify.mjs "$legacy_module" "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture"
node wasm/dsp/verify.mjs "$legacy_module" "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$adaa_fixture"
node wasm/dsp/verify-live.mjs "$legacy_module" "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$fixture" "$adaa_fixture"
node wasm/dsp/verify-artifact-isolation.mjs public/wasm/aurialis-dsp.wasm "$legacy_module" "$(go env GOROOT)/lib/wasm/wasm_exec.js"
node wasm/dsp/verify-realtime.mjs public/wasm/aurialis-realtime.wasm "$fixture" "$adaa_fixture"

AURIALIS_AUTOMATION_FIXTURE="$automation_fixture" AURIALIS_SOURCE_CLOCK_FIXTURE="$source_clock_fixture" go test ./wasm/dsp -run 'TestWrite(AutomationParity|SourceClockParity)Fixture$' -count=1
node wasm/dsp/verify-automation.mjs public/wasm/aurialis-realtime.wasm "$automation_fixture" "$source_clock_fixture"

AURIALIS_OFFLINE_FIXTURE="$offline_fixture" go test ./wasm/dsp -run 'TestWriteOfflineJobParityFixture$' -count=1
node wasm/dsp/verify-offline.mjs public/wasm/aurialis-dsp.wasm "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$offline_fixture"

AURIALIS_OVERSAMPLED_FIXTURE="$oversampled_fixture" go test ./wasm/dsp -run TestWriteOversampledParityFixture -count=1
node wasm/dsp/verify-oversampling.mjs public/wasm/aurialis-realtime.wasm "$oversampled_fixture"
node wasm/dsp/verify-monitor.mjs public/wasm/aurialis-realtime.wasm
