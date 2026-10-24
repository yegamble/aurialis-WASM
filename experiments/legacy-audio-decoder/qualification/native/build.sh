#!/usr/bin/env bash
# Private build recipe only. This script never fetches sources or image layers.
set -euo pipefail
if [[ "$#" != 2 && "$#" != 3 ]]; then
  echo "Usage: build.sh VERIFIED_FFMPEG_GIT_CHECKOUT NEW_OUTPUT_DIRECTORY [VERIFIED_NATIVE01_OUTPUT]" >&2
  exit 2
fi
TASK_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
FFMPEG_SOURCE="$(cd "$1" && pwd -P)"
TASK_OUTPUT="$2"
[[ "$TASK_OUTPUT" = /* && ! -e "$TASK_OUTPUT" ]] || { echo "Output must be a new absolute directory." >&2; exit 2; }
COMMIT="bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa"
TREE="68fad6870d0f112fcf4e385d798bf268b2b938b0"
[[ "$(git -C "$FFMPEG_SOURCE" rev-parse HEAD)" = "$COMMIT" ]]
[[ "$(git -C "$FFMPEG_SOURCE" rev-parse 'HEAD^{tree}')" = "$TREE" ]]
[[ -z "$(git -C "$FFMPEG_SOURCE" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] || {
  echo "FFmpeg checkout must be pristine, including ignored/untracked files." >&2; exit 2;
}
mkdir -m 700 "$TASK_OUTPUT"
# The controller records actual container state, including OOM, before cleanup.
# It never fetches an image and refuses to exceed its fixed resource policy.
if [[ "$#" = 3 ]]; then
  python3 "$TASK_ROOT/run-build.py" "$FFMPEG_SOURCE" "$TASK_ROOT" "$TASK_OUTPUT" "$3"
else
  python3 "$TASK_ROOT/run-build.py" "$FFMPEG_SOURCE" "$TASK_ROOT" "$TASK_OUTPUT"
fi
