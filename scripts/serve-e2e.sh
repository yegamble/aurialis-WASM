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
  python3 - "$binary" <<'PY'
import subprocess
import sys
import os
import signal

process = subprocess.Popen(["bash", "scripts/build-e2e.sh", sys.argv[1]], start_new_session=True)
try:
    result = process.wait(timeout=480)
except subprocess.TimeoutExpired as error:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    raise SystemExit(f"Cold QA build exceeded its 8 minute deadline: {error}")
if result != 0:
    raise SystemExit(result)
PY
fi
if ! LC_ALL=C grep -aFq '{"schema":1,"target":"native"}' "$binary"; then
  printf 'Native Playwright refuses a binary without the embedded native build-target marker.\n' >&2
  exit 1
fi
printf 'Test-instrumented binary: %s\n' "$binary"
if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$binary"; else sha256sum "$binary"; fi
"$binary" --addr "127.0.0.1:$port" --stem-model-url "" &
server_pid="$!"
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  target="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/build-target-native.json" 2>/dev/null || true)"
  if [ "$target" = '{"schema":1,"target":"native"}' ]; then
    wait "$server_pid"
    exit $?
  fi
  sleep 0.25
done
printf 'Native Playwright server did not expose the native build marker within 30 seconds.\n' >&2
exit 1
