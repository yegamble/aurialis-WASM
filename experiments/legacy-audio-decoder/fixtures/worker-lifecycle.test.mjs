/* Execute the actual private Worker source with inert module/input adapters.
 * This does not load Wasm, decode audio, allocate a real decoder heap or browse.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import { readBoundedResponse } from "../bounded-read.mjs";

const workerSource = (await readFile(new URL("../decoder.worker.mjs", import.meta.url), "utf8"))
  .replace(/^import .+;$/gm, "")
  .replaceAll("import.meta.url", "fixtureModuleURL")
  .replace("__AURIALIS_WASM_SHA256__", "00".repeat(32));
function deferred() { let resolve; const promise = new Promise((settle) => { resolve = settle; }); return { promise, resolve }; }
function harness({ fetch, createDecoder }) {
  const sent = [], counts = { memories: 0 };
  const context = createContext({
    onmessage: null, readBoundedResponse, fixtureModuleURL: "https://fixture.invalid/private/decoder.worker.mjs",
    URL, Uint8Array, ArrayBuffer, DataView, Number, Error,
    crypto: { subtle: { async digest() { return new ArrayBuffer(32); } } },
    WebAssembly: { Memory: class { constructor() { counts.memories++; } } },
    selectedInput: () => ({ size: 32, read: () => new Uint8Array(0) }),
    inspectEnvelope: () => 1,
    postMessage: (value) => { sent.push(value); },
    fetch, createDecoder,
  });
  new Script(workerSource, { filename: "private-decoder-worker-fixture.js" }).runInContext(context);
  return { counts, sent,
    start: () => context.onmessage({ data: { abi: 1, kind: "start", id: "fixture", file: {}, maxFrames: 2 } }),
    fail: () => context.onmessage({ data: { abi: 1, kind: "ack", id: "fixture", sequence: 1 } }),
  };
}
function asset() {
  let done = false;
  return { ok: true, body: { getReader: () => ({
    async read() { if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array([0]) }; },
    async cancel() {}, releaseLock() {},
  }) } };
}
test("a terminal error during asset fetch prevents later memory or module initialization", async () => {
  const fetched = deferred(); let factories = 0;
  const fixture = harness({ fetch: () => fetched.promise, createDecoder: async () => { factories++; return {}; } });
  const started = fixture.start();
  await fixture.fail(); fetched.resolve(asset()); await started;
  assert.equal(fixture.sent.filter((value) => value.kind === "error").length, 1);
  assert.equal(fixture.counts.memories, 0); assert.equal(factories, 0);
});
test("a terminal error during factory initialization closes a late core before opening or pumping it", async () => {
  const initialized = deferred(), entered = deferred();
  const calls = { open: 0, next: 0, close: 0 };
  const fixture = harness({ fetch: async () => asset(), createDecoder: () => { entered.resolve(); return initialized.promise; } });
  const started = fixture.start();
  await entered.promise; await fixture.fail();
  initialized.resolve({
    HEAPU8: { buffer: { byteLength: 64 * 1024 * 1024 } },
    _aurialis_decoder_abi: () => 1,
    _aurialis_decoder_open: () => { calls.open++; return 0; },
    _aurialis_decoder_next: () => { calls.next++; return -1; },
    _aurialis_decoder_close: () => { calls.close++; },
  });
  await started;
  assert.equal(fixture.counts.memories, 1);
  assert.deepEqual(calls, { open: 0, next: 0, close: 1 });
  assert.equal(fixture.sent.filter((value) => value.kind === "error").length, 1);
});
