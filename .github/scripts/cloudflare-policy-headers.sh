#!/usr/bin/env bash

cloudflare_header() {
  local name="$1" file="$2"
  awk -v wanted="$name" 'tolower($1) == wanted ":" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value = $0 } END { print value }' "$file"
}

assert_cloudflare_policy_headers() {
  local origin="$1" file="$2" name expected actual
  while IFS='|' read -r name expected; do
    actual="$(cloudflare_header "$name" "$file")"
    if [ "$actual" != "$expected" ]; then
      printf '::error::%s is missing the required %s header (got %s).\n' "$origin" "$name" "${actual:-none}" >&2
      return 1
    fi
  done <<'HEADERS'
cross-origin-opener-policy|same-origin
cross-origin-embedder-policy|require-corp
cache-control|no-store, no-transform
x-frame-options|DENY
strict-transport-security|max-age=63072000; includeSubDomains
permissions-policy|camera=(), microphone=(), geolocation=(), payment=(), usb=()
HEADERS
}
