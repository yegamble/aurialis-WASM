#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${AURIALIS_USE_CI_BROWSER_ASSETS:-0}" in
  1) NEXT_PUBLIC_AURIALIS_EXECUTION=browser python3 scripts/ci-browser-artifacts.py verify ;;
  0) ;;
  *) printf 'Invalid browser CI asset mode\n' >&2; exit 1 ;;
esac
exec pnpm exec wrangler dev -c deploy/cloudflare/wrangler.jsonc --ip 127.0.0.1 --port 3927 --local
