#!/usr/bin/env bash
set -euo pipefail
# Build only the QA executable from the already-built production embedded assets.
cd "$(dirname "$0")/.."
binary="${1:?Provide the output QA binary path}"
asset="internal/webui/embedded/__qa/actual-output-tap.js"
asset_dir="$(dirname "$asset")"
owner_file="$asset_dir/.aurialis-build-e2e-owner"
native_target="internal/webui/embedded/build-target-native.json"
staged_asset=false
asset_installed=false
stage_file=""
asset_hash=""
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
source_hash="$(hash_file e2e/support/actual-output-tap.js)"
build_owner="aurialis-build-e2e-v1 $$ $source_hash"
cleanup() {
  if [ -n "$stage_file" ]; then rm -f "$stage_file"; fi
  if [ "$staged_asset" = true ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] \
    && [ "$(cat "$owner_file")" = "$build_owner" ]; then
    if [ "$asset_installed" = true ] && [ -f "$asset" ] && [ ! -L "$asset" ] \
      && [ "$(hash_file "$asset")" = "$asset_hash" ]; then rm -f "$asset"; fi
    rm -f "$owner_file"
    rmdir "$asset_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -L "$binary" ] || [ "$binary" -ef "$PWD/aurialis" ]; then
  printf 'QA output must be separate from production.\n' >&2
  exit 1
fi
mkdir -p "$(dirname "$binary")"
output_directory="$(cd "$(dirname "$binary")" && pwd -P)"
if [ "$output_directory/$(basename "$binary")" = "$(pwd -P)/aurialis" ]; then
  printf 'QA output must be separate from production.\n' >&2
  exit 1
fi
if [ ! -f "$native_target" ] || [ -L "$native_target" ]; then
  printf 'The embedded frontend is not marked as a native build; refusing to create a native Playwright binary.\n' >&2
  exit 1
fi
python3 - "$native_target" <<'PY'
import json
import pathlib
import sys

if json.loads(pathlib.Path(sys.argv[1]).read_text()) != {"schema": 1, "target": "native"}:
    raise SystemExit("The embedded frontend target is not native.")
PY
asset_hash="$source_hash"
if [ -e "$owner_file" ] || [ -L "$owner_file" ]; then
  if [ -L "$owner_file" ] || [ ! -f "$owner_file" ]; then
    printf 'Unrecognized QA staging ownership record; preserving it and refusing to continue.\n' >&2
    exit 1
  fi
  read -r marker_version marker_pid marker_hash marker_extra < "$owner_file"
  if [ "$marker_version" != "aurialis-build-e2e-v1" ] || ! [[ "$marker_pid" =~ ^[0-9]+$ ]] \
    || ! [[ "$marker_hash" =~ ^[0-9a-f]{64}$ ]] || [ -n "${marker_extra:-}" ]; then
    printf 'Unrecognized QA staging ownership record; preserving it and refusing to continue.\n' >&2
    exit 1
  fi
  if kill -0 "$marker_pid" 2>/dev/null; then
    printf 'A QA staging process with PID %s is still active; preserving its files.\n' "$marker_pid" >&2
    exit 1
  fi
  if [ -L "$asset" ] || { [ -e "$asset" ] && { [ ! -f "$asset" ] || [ "$(hash_file "$asset")" != "$marker_hash" ]; }; }; then
    printf 'QA staging residue differs from its ownership checksum; preserving it and refusing to continue.\n' >&2
    exit 1
  fi
  rm -f "$asset" "$owner_file"
  rmdir "$asset_dir" 2>/dev/null || true
elif [ -e "$asset" ] || [ -L "$asset" ]; then
  printf 'An unowned QA observer asset exists; preserving it and refusing to continue.\n' >&2
  exit 1
fi
test -s internal/webui/embedded/wasm/aurialis-realtime.wasm
mkdir -p "$(dirname "$binary")" "$asset_dir"
if [ -e "$asset" ] || [ -L "$asset" ] || [ -e "$owner_file" ] || [ -L "$owner_file" ]; then
  printf 'QA staging path changed during setup; preserving it and refusing to continue.\n' >&2
  exit 1
fi
stage_file="$(mktemp "$asset_dir/.actual-output-tap.XXXXXX")"
cp e2e/support/actual-output-tap.js "$stage_file"
test "$(hash_file "$stage_file")" = "$asset_hash"
( set -o noclobber; printf '%s\n' "$build_owner" > "$owner_file" ) || {
  printf 'Could not claim QA staging ownership; preserving existing files.\n' >&2
  exit 1
}
staged_asset=true
if [ -e "$asset" ] || [ -L "$asset" ]; then
  printf 'QA observer destination appeared during setup; preserving it and refusing to continue.\n' >&2
  exit 1
fi
mv "$stage_file" "$asset"
stage_file=""
asset_installed=true
go build -trimpath -o "$binary" ./cmd/aurialis
printf 'Built separate test-instrumented binary: %s\n' "$binary"
