#!/usr/bin/env bash
set -euo pipefail

# Run from any directory; all release assets are rebuilt from this checkout.
cd "$(dirname "$0")/.."
node scripts/sync-licenses.mjs
mkdir -p public/wasm
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o public/wasm/aurialis-realtime.wasm ./wasm/dsp
# Go's downloaded toolchain is read-only. Replace the runtime atomically so a
# second build also works when an older copy retained the source's 0444 mode.
runtime_copy="$(mktemp public/wasm/wasm_exec.XXXXXX)"
trap 'rm -f "$runtime_copy"' EXIT
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$runtime_copy"
chmod 0644 "$runtime_copy"
mv -f "$runtime_copy" public/wasm/wasm_exec.js
pnpm run build
test -s internal/webui/embedded/wasm/aurialis-dsp.wasm
test -s internal/webui/embedded/wasm/aurialis-realtime.wasm
go build -trimpath -o aurialis ./cmd/aurialis
printf 'Built %s/aurialis with embedded frontend and WASM.\n' "$PWD"
