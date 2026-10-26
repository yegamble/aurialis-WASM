#!/usr/bin/env bash
set -euo pipefail
# cspell:words trimpath
cd "$(dirname "$0")/.."
# Keep the production binary/assets unchanged. Only this temporary test binary
# embeds an additional static observer module; all normal handlers/CSP remain.
port="${1:-3847}"
case "$port" in ''|*[!0-9]*) printf 'Invalid test port\n' >&2; exit 1 ;; esac
server_pid=""
owned_binary=false
binary="${AURIALIS_E2E_BINARY:-}"
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [ "$owned_binary" = true ]; then rm -f "$binary"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$binary" ]; then
  python3 scripts/ci-artifacts.py verify --binary "$binary"
  test "$binary" = "$PWD/artifacts/ci-runtime/aurialis-e2e"
else
  binary="$(mktemp "${TMPDIR:-/tmp}/aurialis-e2e.XXXXXX")"
  owned_binary=true
  bash scripts/build-e2e.sh "$binary"
fi
printf 'Test-instrumented binary: %s\n' "$binary"
if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$binary"; else sha256sum "$binary"; fi
"$binary" --addr "127.0.0.1:$port" --stem-model-url "" &
server_pid="$!"
wait "$server_pid"
