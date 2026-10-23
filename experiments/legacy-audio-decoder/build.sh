#!/usr/bin/env bash
# Private build recipe only. This script never fetches sources or image layers.
set -euo pipefail
if [[ "$#" != 2 ]]; then
  echo "Usage: build.sh VERIFIED_FFMPEG_GIT_CHECKOUT NEW_OUTPUT_DIRECTORY" >&2
  exit 2
fi
TASK_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
FFMPEG_SOURCE="$(cd "$1" && pwd -P)"
TASK_OUTPUT="$2"
[[ "$TASK_OUTPUT" = /* && ! -e "$TASK_OUTPUT" ]] || { echo "Output must be a new absolute directory." >&2; exit 2; }
COMMIT="bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa"
TREE="68fad6870d0f112fcf4e385d798bf268b2b938b0"
IMAGE="emscripten/emsdk@sha256:badbe38bedc8f4ff88a5a24672a2d59606015ba9a3bbe69801ad2fbdf75ab500"
[[ "$(git -C "$FFMPEG_SOURCE" rev-parse HEAD)" = "$COMMIT" ]]
[[ "$(git -C "$FFMPEG_SOURCE" rev-parse 'HEAD^{tree}')" = "$TREE" ]]
[[ -z "$(git -C "$FFMPEG_SOURCE" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] || {
  echo "FFmpeg checkout must be pristine, including ignored/untracked files." >&2; exit 2;
}
docker image inspect "$IMAGE" >/dev/null
mkdir -m 700 "$TASK_OUTPUT"
# The image digest is the explicit linux/amd64 manifest, not a floating tag.
# No host FS is exposed to runtime decoding; these read-only mounts are build-only.
docker run --rm --pull=never --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev \
  -e SOURCE_DATE_EPOCH=1786505071 -e TZ=UTC -e LC_ALL=C \
  -e EM_CACHE=/output/emcache \
  -v "$FFMPEG_SOURCE:/ffmpeg:ro" -v "$TASK_ROOT:/recipe:ro" -v "$TASK_OUTPUT:/output:rw" \
  "$IMAGE" bash /recipe/build-container.sh
