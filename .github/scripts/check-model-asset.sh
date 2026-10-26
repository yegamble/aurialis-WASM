#!/usr/bin/env bash
# Confirm the Smart Split model release asset still matches the pins compiled
# into internal/audio/steminfer. Values are read from the Go source so this
# check cannot drift from what the binary will download and verify.
# Usage: check-model-asset.sh   (run from the repository root; needs curl and gh)
set -euo pipefail

src=internal/audio/steminfer
fail() { echo "::error::$1" >&2; exit 1; }

url="$(sed -nE 's/^const ModelURL = "([^"]+)"$/\1/p' "$src/model.go")"
bytes="$(sed -nE 's/^const modelBytes = ([0-9]+)$/\1/p' "$src/weights.go")"
sha="$(sed -nE 's/^const modelSHA256 = "([0-9a-f]{64})"$/\1/p' "$src/weights.go")"
[ -n "$url" ] || fail "could not read ModelURL from $src/model.go; update this script with the new declaration."
[ -n "$bytes" ] || fail "could not read modelBytes from $src/weights.go; update this script with the new declaration."
[ -n "$sha" ] || fail "could not read modelSHA256 from $src/weights.go; update this script with the new declaration."

pattern='^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/]+)$'
[[ "$url" =~ $pattern ]] || fail "ModelURL $url is not a GitHub release asset URL."
repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}" tag="${BASH_REMATCH[3]}" asset="${BASH_REMATCH[4]}"
echo "Model: $url"
echo "Expected: $bytes bytes, sha256 $sha"

# Follow the release redirect; only the final response's status and length count.
headers="$(curl -sSIL --retry 3 --max-time 60 "$url")" || fail "HEAD $url failed."
status="$(printf '%s\n' "$headers" | tr -d '\r' | grep -iE '^HTTP/' | tail -n 1 | awk '{print $2}')"
length="$(printf '%s\n' "$headers" | tr -d '\r' | grep -i '^content-length:' | tail -n 1 | awk '{print $2}')"
[ "$status" = "200" ] || fail "HEAD $url ended with HTTP ${status:-none}; Smart Split cannot download its model."
[ "$length" = "$bytes" ] || fail "HEAD $url reports Content-Length ${length:-none}, want $bytes; the binary will reject this file."

# GitHub records a SHA-256 for each uploaded asset, so a replaced file is caught
# without downloading 176 MB.
digest="$(gh api "repos/$repo/releases/tags/$tag" --jq ".assets[] | select(.name == \"$asset\") | .digest")" \
  || fail "could not read release $tag of $repo."
[ "$digest" = "sha256:$sha" ] || fail "release asset $asset digest is ${digest:-missing}, want sha256:$sha."

echo "Model asset OK: HTTP 200, $length bytes, $digest"
