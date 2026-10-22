#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm run build:binary
printf 'Integrated studio: http://127.0.0.1:3000 (restart pnpm dev after source changes).\n'
export AURIALIS_ADDR="${AURIALIS_ADDR:-127.0.0.1:3000}"
exec ./aurialis
