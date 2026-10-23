#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/sync-licenses.mjs
mkdir -p public/wasm
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o public/wasm/aurialis-realtime.wasm ./wasm/dsp
runtime_copy="$(mktemp public/wasm/wasm_exec.XXXXXX)"
trap 'rm -f "$runtime_copy"' EXIT
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$runtime_copy"
chmod 0644 "$runtime_copy"
mv -f "$runtime_copy" public/wasm/wasm_exec.js
NEXT_PUBLIC_AURIALIS_EXECUTION=browser pnpm run build
node scripts/prepare-browser-assets.mjs
