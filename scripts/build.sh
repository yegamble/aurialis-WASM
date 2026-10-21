#!/usr/bin/env bash
set -euo pipefail

# Run from any directory; all release assets are rebuilt from this checkout.
cd "$(dirname "$0")/.."
mkdir -p public/wasm
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" public/wasm/wasm_exec.js
pnpm run build
test -s internal/webui/embedded/wasm/aurialis-dsp.wasm
go build -trimpath -o aurialis ./cmd/aurialis
printf 'Built %s/aurialis with embedded frontend and WASM.\n' "$PWD"
