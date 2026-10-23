import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../public/offline-job-worker.js', import.meta.url), 'utf8');
const moduleBytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const fingerprint = 'a'.repeat(64), offlineSha256 = createHash('sha256').update(moduleBytes).digest('hex');
async function worker(processing, responseBytes = moduleBytes) {
  const messages = [], fetched = [], imported = [];
  let instantiations = 0, close;
  const completed = new Promise((resolve) => { close = resolve; });
  // Synthetic bootstrap only; real Go/WASM processing requires separate oracles.
  const self = { close: () => { close(); }, postMessage: (message) => { messages.push(message); } };
  const context = { self, ArrayBuffer, Uint8Array, crypto: webcrypto,
    importScripts: (url) => { imported.push(url); self.Go = class { importObject = {}; run() { self.aurialisOfflineAbi = '1.0'; self.aurialisOfflineJob = () => ({ ok: true, json: '{}', audio: new Uint8Array(0) }); return Promise.resolve(); } }; },
    fetch: async (url) => { fetched.push(url); return new Response(responseBytes); },
    WebAssembly: { instantiate: async () => { instantiations++; return { instance: {} }; } },
  };
  runInNewContext(source, context);
  self.onmessage({ data: { abi: '1.0', id: 'test', metadata: '{}', source: new ArrayBuffer(0), reference: new ArrayBuffer(0), processing } });
  await completed; return { messages, instantiations, fetched, imported };
}
test('qualified worker hashes actual fetched bytes before instantiation', { timeout: 1000 }, async () => {
  const result = await worker({ fingerprint, offlineSha256: '0'.repeat(64), offlineBytes: moduleBytes.length });
  assert.equal(result.instantiations, 0); assert.equal(result.messages.at(-1).kind, 'error'); assert.match(result.messages.at(-1).error, /processing module.*match/i); assert.equal(result.messages.at(-1).processingBuild, '');
});
test('qualified matching module returns its checked processing identity', { timeout: 1000 }, async () => {
  const result = await worker({ fingerprint, offlineSha256, offlineBytes: moduleBytes.length });
  assert.equal(result.instantiations, 1); assert.equal(result.messages.at(-1).kind, 'result'); assert.equal(result.messages.at(-1).processingBuild, fingerprint);
  assert.match(result.fetched[0], new RegExp(fingerprint));
});
test('malformed processing envelopes reject before runtime import or fetch', { timeout: 1000 }, async () => {
  for (const malformed of [{ fingerprint, offlineSha256: 'invalid', offlineBytes: moduleBytes.length }, { fingerprint, offlineSha256, offlineBytes: moduleBytes.length, unexpected: true }]) {
    const result = await worker(malformed); assert.equal(result.instantiations, 0); assert.equal(result.imported.length, 0); assert.equal(result.fetched.length, 0); assert.equal(result.messages.at(-1).kind, 'error');
  }
});

test('qualified worker stops an oversized response before instantiation', { timeout: 1000 }, async () => {
  const result = await worker({ fingerprint, offlineSha256, offlineBytes: moduleBytes.length }, Uint8Array.of(...moduleBytes, 0));
  assert.equal(result.instantiations, 0); assert.equal(result.messages.at(-1).kind, 'error'); assert.match(result.messages.at(-1).error, /unexpected length/); assert.equal(result.messages.at(-1).processingBuild, '');
});
