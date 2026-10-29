#!/usr/bin/env bash
# Smoke-test a deployed Cloudflare origin against the exact restored build.
# Usage: smoke-cloudflare.sh <origin> [<origin> ...]
# Requires deploy/cloudflare/assets (restored CI artifact) for the HTML digest.
set -euo pipefail

source "$(dirname "$0")/cloudflare-policy-headers.sh"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <origin> [<origin> ...]" >&2
  exit 2
fi

expected_html="$(sha256sum deploy/cloudflare/assets/index.html | cut -d' ' -f1)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "::error::$1"
  if [ -n "${SMOKE_FAILURE_HINT:-}" ]; then echo "::error::$SMOKE_FAILURE_HINT"; fi
  exit 1
}

# Edge propagation of a new deployment is not instantaneous; retry the HTML
# digest until it matches before asserting anything else.
check_origin() {
  local origin="${1%/}" attempt
  for attempt in 1 2 3 4 5 6; do
    if curl -fsS --max-time 20 -D "$work/html.h" -o "$work/index.html" "$origin/" \
      && [ "$(sha256sum "$work/index.html" | cut -d' ' -f1)" = "$expected_html" ]; then
      break
    fi
    [ "$attempt" -eq 6 ] && fail "$origin/ never served the built index.html (sha256 $expected_html)."
    sleep 10
  done

  assert_cloudflare_policy_headers "$origin" "$work/html.h" || fail "$origin/ response headers do not meet the production policy."

  curl -fsS --max-time 30 -D "$work/wasm.h" -o /dev/null "$origin/wasm/aurialis-dsp.wasm" \
    || fail "$origin/wasm/aurialis-dsp.wasm did not load."
  [ "$(cloudflare_header content-type "$work/wasm.h")" = "application/wasm" ] || fail "$origin WASM is not served as application/wasm."

  local status
  status="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST "$origin/")"
  [ "$status" = "405" ] || fail "$origin/ accepted POST (HTTP $status); the site must accept no uploads."

  echo "Smoke test passed: $origin"
}

for origin in "$@"; do check_origin "$origin"; done
