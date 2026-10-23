#!/usr/bin/env bash
set -euo pipefail
# cspell:words trimpath
cd "$(dirname "$0")/.."
# Keep the production binary/assets unchanged. Only this temporary test binary
# embeds an additional static observer module; all normal handlers/CSP remain.
port="${1:-3847}"
case "$port" in ''|*[!0-9]*) printf 'Invalid test port\n' >&2; exit 1 ;; esac
binary="$(mktemp "${TMPDIR:-/tmp}/aurialis-e2e.XXXXXX")"
asset="internal/webui/embedded/__qa/actual-output-tap.js"
server_pid=""
staged_asset=false
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [ "$staged_asset" = true ]; then rm -f "$asset"; rmdir internal/webui/embedded/__qa 2>/dev/null || true; fi
  rm -f "$binary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e "$asset" ]; then printf 'A QA observer asset is already staged; refusing to replace it.\n' >&2; exit 1; fi
test -s internal/webui/embedded/wasm/aurialis-realtime.wasm
mkdir -p internal/webui/embedded/__qa
staged_asset=true
cp e2e/support/actual-output-tap.js "$asset"
go build -trimpath -o "$binary" ./cmd/aurialis
rm -f "$asset"
rmdir internal/webui/embedded/__qa
printf 'Test-instrumented binary: %s\n' "$binary"
if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$binary"; else sha256sum "$binary"; fi
"$binary" --addr "127.0.0.1:$port" &
server_pid="$!"
wait "$server_pid"
