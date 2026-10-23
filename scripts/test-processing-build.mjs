import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { processingDescriptor, publicProcessingIdentity, verifyEmbeddedProcessing } from './processing-build.mjs';
const tools = { node: '26.12.0', pnpm: '10.33.0', go: { GOVERSION: 'go1.26.10', GOOS: 'darwin', GOARCH: 'arm64', GOFLAGS: '', GOEXPERIMENT: '', CGO_ENABLED: '1' } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aurialis-processing-build-'));
  const put = (name, content) => { const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); };
  // Synthetic module envelopes exercise identity; they do not prove compiled DSP.
  put('public/wasm/aurialis-dsp.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1]));
  put('public/wasm/aurialis-realtime.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 2]));
  put('public/wasm/wasm_exec.js', 'runtime'); put('go.mod', 'go 1.26.10'); put('pnpm-lock.yaml', 'lock'); put('package.json', '{}');
  put('src/lib/audio.ts', 'contract'); put('internal/audio/dsp/engine.go', 'package dsp'); put('public/offline-job-worker.js', 'worker');
  return { root, put, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
test('identity is deterministic across locations and excludes test/generated output bytes', () => {
  const first = fixture(), second = fixture();
  try {
    const original = processingDescriptor(first.root, 'native', tools);
    first.put('src/lib/__tests__/audio.test.ts', 'test'); first.put('internal/webui/embedded/index.html', 'old build'); first.put('public/processing-build.json', 'generated');
    assert.deepEqual(processingDescriptor(first.root, 'native', tools), original);
    assert.deepEqual(processingDescriptor(second.root, 'native', tools), original);
    assert.equal(publicProcessingIdentity(original).fingerprint.length, 64);
  } finally { first.dispose(); second.dispose(); }
});
test('actual module, Go, frontend, worker, lock, tooling and target changes invalidate identity', () => {
  for (const path of ['public/wasm/aurialis-dsp.wasm', 'public/wasm/aurialis-realtime.wasm', 'public/wasm/wasm_exec.js', 'internal/audio/dsp/engine.go', 'src/lib/audio.ts', 'public/offline-job-worker.js', 'pnpm-lock.yaml']) {
    const sample = fixture();
    try {
      const original = publicProcessingIdentity(processingDescriptor(sample.root, 'native', tools)).fingerprint;
      sample.put(path, Buffer.concat([readFileSync(join(sample.root, path)), Buffer.from('changed')]));
      assert.notEqual(publicProcessingIdentity(processingDescriptor(sample.root, 'native', tools)).fingerprint, original, path);
    } finally { sample.dispose(); }
  }
  const sample = fixture();
  try {
    const original = publicProcessingIdentity(processingDescriptor(sample.root, 'native', tools)).fingerprint;
    assert.notEqual(publicProcessingIdentity(processingDescriptor(sample.root, 'browser', tools)).fingerprint, original);
    assert.notEqual(publicProcessingIdentity(processingDescriptor(sample.root, 'native', { ...tools, go: { ...tools.go, GOARCH: 'amd64' } })).fingerprint, original);
    assert.throws(() => processingDescriptor(sample.root, 'native', { ...tools, node: '19.9.0' }), /pinned/);
    assert.throws(() => processingDescriptor(sample.root, 'native', { ...tools, go: { ...tools.go, GOFLAGS: '-race' } }), /flags/);
  } finally { sample.dispose(); }
});
test('native verification rejects stale embedded UI and changed actual module bytes', () => {
  const sample = fixture();
  try {
    const descriptor = processingDescriptor(sample.root, 'native', tools), identity = publicProcessingIdentity(descriptor);
    sample.put('internal/webui/embedded/processing-build.json', JSON.stringify(identity));
    for (const name of ['aurialis-dsp.wasm', 'aurialis-realtime.wasm', 'wasm_exec.js']) sample.put(`internal/webui/embedded/wasm/${name}`, readFileSync(join(sample.root, `public/wasm/${name}`)));
    assert.equal(verifyEmbeddedProcessing(sample.root, descriptor), identity.fingerprint);
    sample.put('internal/webui/embedded/processing-build.json', JSON.stringify({ ...identity, fingerprint: 'a'.repeat(64) }));
    assert.throws(() => verifyEmbeddedProcessing(sample.root, descriptor), /embedded/);
    sample.put('internal/webui/embedded/processing-build.json', JSON.stringify(identity)); sample.put('internal/webui/embedded/wasm/aurialis-dsp.wasm', 'wrong');
    assert.throws(() => verifyEmbeddedProcessing(sample.root, descriptor), /module/);
  } finally { sample.dispose(); }
});
