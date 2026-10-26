#!/usr/bin/env bash
set -euo pipefail

PORT="${AURIALIS_TEST_PORT:-18765}"
BASE_URL="http://127.0.0.1:${PORT}"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# Generate a clean 0.4s stereo 48kHz 16-bit WAV fixture and a spoofed PDF fixture
VALID_WAV="${TMP_DIR}/fixture.wav"
SPOOF_PDF="${TMP_DIR}/spoof.wav"

node -e '
const fs = require("fs");
const sampleRate = 48000;
const numFrames = 19200;
const dataSize = numFrames * 4;
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < numFrames; i++) {
  const t = i / sampleRate;
  const sL = Math.round(Math.sin(2 * Math.PI * 220 * t) * 12000);
  const sR = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000);
  buf.writeInt16LE(sL, 44 + i * 4);
  buf.writeInt16LE(sR, 44 + i * 4 + 2);
}
fs.writeFileSync(process.argv[1], buf);
fs.writeFileSync(process.argv[2], Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"));
' "${VALID_WAV}" "${SPOOF_PDF}"

BINARY="${AURIALIS_TEST_BINARY:-}"
if [ -n "$BINARY" ]; then
  python3 scripts/ci-artifacts.py verify --binary "$BINARY"
  test "$BINARY" = "$PWD/aurialis"
else
  BINARY="${TMP_DIR}/aurialis"
  go build -o "$BINARY" ./cmd/aurialis
fi
echo "==> Starting validated aurialis on ${BASE_URL} (max upload cap = 1 MB for fast 413 probe)..."
"$BINARY" -addr "127.0.0.1:${PORT}" -max-upload-bytes 1048576 -workers 4 -stem-model-url "" &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

echo "==> Running Newman collection (TS-001 through TS-032)..."
pnpm exec newman run tests/postman/aurialis-backend.postman_collection.json \
  --env-var "baseUrl=${BASE_URL}" \
  --env-var "validWavPath=${VALID_WAV}" \
  --env-var "spoofPdfPath=${SPOOF_PDF}" \
  --reporters cli

echo "==> Running raw cURL security & oversized payload (413) probes..."
HTTP_DNS=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.attacker.com" "${BASE_URL}/health")
if [ "${HTTP_DNS}" != "403" ]; then
  echo "Expected 403 for DNS rebinding Host header, got ${HTTP_DNS}"
  exit 1
fi

OVERSIZED_FILE="${TMP_DIR}/oversized.wav"
dd if=/dev/zero of="${OVERSIZED_FILE}" bs=1024 count=1200 status=none
HTTP_413=$(curl -s -o /dev/null -w "%{http_code}" -X POST -F "file=@${OVERSIZED_FILE}" -F "stems=2" "${BASE_URL}/separate")
if [ "${HTTP_413}" != "413" ]; then
  echo "Expected 413 for oversized upload, got ${HTTP_413}"
  exit 1
fi

echo "==> All Newman & cURL backend security probes passed!"
