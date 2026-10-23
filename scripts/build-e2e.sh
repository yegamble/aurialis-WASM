#!/usr/bin/env bash
set -euo pipefail
# Build only the QA executable from the already-built production embedded assets.
cd "$(dirname "$0")/.."
binary="${1:?Provide the output QA binary path}"
asset="internal/webui/embedded/__qa/actual-output-tap.js"
staged_asset=false
cleanup() {
  if [ "$staged_asset" = true ]; then rm -f "$asset"; rmdir internal/webui/embedded/__qa 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -L "$binary" ] || [ "$binary" -ef "$PWD/aurialis" ]; then
  printf 'QA output must be separate from production.\n' >&2
  exit 1
fi
mkdir -p "$(dirname "$binary")"
output_directory="$(cd "$(dirname "$binary")" && pwd -P)"
if [ "$output_directory/$(basename "$binary")" = "$(pwd -P)/aurialis" ]; then
  printf 'QA output must be separate from production.\n' >&2
  exit 1
fi
if [ -e "$asset" ]; then printf 'A QA observer asset is already staged; refusing to replace it.\n' >&2; exit 1; fi
test -s internal/webui/embedded/wasm/aurialis-realtime.wasm
processing_fingerprint="$(node scripts/processing-build.mjs verify-native native)"
mkdir -p "$(dirname "$binary")" internal/webui/embedded/__qa
staged_asset=true
cp e2e/support/actual-output-tap.js "$asset"
go build -trimpath -ldflags "-X github.com/yegamble/Aurialis-WASM/internal/build.Fingerprint=$processing_fingerprint" -o "$binary" ./cmd/aurialis
printf 'Built separate test-instrumented binary: %s\n' "$binary"
