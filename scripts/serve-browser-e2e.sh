#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${AURIALIS_BROWSER_QA:-0}" != 1 ]; then
  printf 'Set AURIALIS_BROWSER_QA=1 to start the test-only browser server.\n' >&2
  exit 1
fi
# Job control gives each directly owned child a distinct process group, including
# pnpm, Wrangler and Worker runtime descendants. Works with macOS Bash 3 and Linux Bash.
set -m
upstream_pid=""
proxy_pid=""
cleanup() {
  trap - EXIT INT TERM
  for child in "$proxy_pid" "$upstream_pid"; do
    [ -z "$child" ] || kill -TERM -- "-$child" 2>/dev/null || true
  done
  deadline=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$deadline" ]; do
    alive=false
    for child in "$proxy_pid" "$upstream_pid"; do
      if [ -n "$child" ] && kill -0 -- "-$child" 2>/dev/null; then alive=true; fi
    done
    [ "$alive" = true ] || break
    sleep 0.1
  done
  for child in "$proxy_pid" "$upstream_pid"; do
    if [ -n "$child" ]; then
      kill -KILL -- "-$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The production launcher verifies same-run receipts when CI assets are selected.
# The observer comes from the proxy; neither launcher writes to the built assets.
bash scripts/serve-browser.sh &
upstream_pid=$!
node scripts/serve-browser-qa.mjs &
proxy_pid=$!
while kill -0 "$upstream_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do sleep 0.25; done
printf 'An owned browser QA server stopped; shutting down its companion.\n' >&2
exit 1
