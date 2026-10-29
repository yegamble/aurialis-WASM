#!/usr/bin/env bash
# cspell:words pathlib trimpath
set -euo pipefail
# Build only the QA executable from the already-built production embedded assets.
cd "$(dirname "$0")/.."
binary="${1:?Provide the output QA binary path}"
asset_dir="internal/webui/embedded/__qa"
observer="$asset_dir/actual-output-tap.js"
legacy_wasm="$asset_dir/aurialis-legacy-probe.wasm"
owner_file="$asset_dir/.aurialis-build-e2e-owner"
native_target="internal/webui/embedded/build-target-native.json"
staged_asset=false
observer_installed=false
legacy_installed=false
observer_stage=""
wasm_stage=""
observer_hash=""
legacy_hash=""
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
cleanup() {
  [ -z "$observer_stage" ] || rm -f "$observer_stage"
  [ -z "$wasm_stage" ] || rm -f "$wasm_stage"
  if [ "$staged_asset" = true ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] \
    && [ "$(cat "$owner_file")" = "$build_owner" ]; then
    if [ "$observer_installed" = true ] && [ -f "$observer" ] && [ ! -L "$observer" ] \
      && [ "$(hash_file "$observer")" = "$observer_hash" ]; then rm -f "$observer"; fi
    if [ "$legacy_installed" = true ] && [ -f "$legacy_wasm" ] && [ ! -L "$legacy_wasm" ] \
      && [ "$(hash_file "$legacy_wasm")" = "$legacy_hash" ]; then rm -f "$legacy_wasm"; fi
    rm -f "$owner_file"
    rmdir "$asset_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -L "$binary" ] || { [ -e "$binary" ] && [ "$binary" -ef "$PWD/aurialis" ]; }; then
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
test -s internal/webui/embedded/wasm/aurialis-realtime.wasm
# Build the tagged probe outside the embedded tree before claiming QA asset paths.
wasm_stage="$(mktemp "${TMPDIR:-/tmp}/aurialis-legacy-probe.XXXXXX")"
GOOS=js GOARCH=wasm go build -tags aurialis_legacy_probe -trimpath -o "$wasm_stage" ./wasm/dsp
observer_hash="$(hash_file e2e/support/actual-output-tap.js)"
legacy_hash="$(hash_file "$wasm_stage")"
build_owner="aurialis-build-e2e-v2 $$ $observer_hash $legacy_hash"
if [ -L "$asset_dir" ] || { [ -e "$asset_dir" ] && [ ! -d "$asset_dir" ]; }; then
  printf 'QA asset directory is not a regular directory; preserving it.\n' >&2; exit 1
fi
mkdir -p "$asset_dir"
if [ -e "$owner_file" ] || [ -L "$owner_file" ]; then
  if [ -L "$owner_file" ] || [ ! -f "$owner_file" ]; then
    printf 'Unrecognized QA staging ownership record; preserving it and refusing to continue.\n' >&2; exit 1
  fi
  read -r marker_version marker_pid marker_observer marker_legacy marker_extra < "$owner_file"
  if [ "$marker_version" != "aurialis-build-e2e-v2" ] || ! [[ "$marker_pid" =~ ^[0-9]+$ ]] \
    || ! [[ "$marker_observer" =~ ^[0-9a-f]{64}$ ]] || ! [[ "$marker_legacy" =~ ^[0-9a-f]{64}$ ]] \
    || [ -n "${marker_extra:-}" ]; then
    printf 'Unrecognized QA staging ownership record; preserving it and refusing to continue.\n' >&2; exit 1
  fi
  if kill -0 "$marker_pid" 2>/dev/null; then
    printf 'A QA staging process with PID %s is still active; preserving its files.\n' "$marker_pid" >&2; exit 1
  fi
  for entry in "$observer:$marker_observer" "$legacy_wasm:$marker_legacy"; do
    file="${entry%%:*}"; expected="${entry#*:}"
    if [ -L "$file" ] || { [ -e "$file" ] && { [ ! -f "$file" ] || [ "$(hash_file "$file")" != "$expected" ]; }; }; then
      printf 'QA staging residue differs from its ownership checksum; preserving it and refusing to continue.\n' >&2; exit 1
    fi
  done
  rm -f "$observer" "$legacy_wasm" "$owner_file"
  rmdir "$asset_dir" 2>/dev/null || true
elif [ -e "$observer" ] || [ -L "$observer" ] || [ -e "$legacy_wasm" ] || [ -L "$legacy_wasm" ]; then
  printf 'An unowned QA asset exists; preserving it and refusing to continue.\n' >&2; exit 1
fi
mkdir -p "$asset_dir"
if [ -L "$asset_dir" ] || [ ! -d "$asset_dir" ]; then
  printf 'QA asset directory changed during setup; preserving it.\n' >&2; exit 1
fi
if [ -e "$observer" ] || [ -L "$observer" ] || [ -e "$legacy_wasm" ] || [ -L "$legacy_wasm" ] || [ -e "$owner_file" ] || [ -L "$owner_file" ]; then
  printf 'QA staging path changed during setup; preserving it and refusing to continue.\n' >&2; exit 1
fi
( set -o noclobber; printf '%s\n' "$build_owner" > "$owner_file" ) || {
  printf 'Could not claim QA staging ownership; preserving existing files.\n' >&2; exit 1
}
staged_asset=true
observer_stage="$(mktemp "$asset_dir/.actual-output-tap.XXXXXX")"
cp e2e/support/actual-output-tap.js "$observer_stage"
test "$(hash_file "$observer_stage")" = "$observer_hash"
mv "$observer_stage" "$observer"
observer_stage=""
observer_installed=true
mv "$wasm_stage" "$legacy_wasm"
wasm_stage=""
legacy_installed=true
go build -trimpath -o "$binary" ./cmd/aurialis
printf 'Built separate test-instrumented binary: %s\n' "$binary"
