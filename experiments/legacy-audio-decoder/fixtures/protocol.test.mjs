/* Synthetic protocol units. They do not execute FFmpeg, Go CDR or a browser. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { recoverCompressedFixture, recoveryPeakBytes } from "../client.mjs";

const originalWorker = globalThis.Worker, originalFetch = globalThis.fetch, originalBlob = globalThis.Blob;
const workerName = "decoder.worker." + "a".repeat(64) + ".mjs";
const file = () => new File([new Uint8Array(32)], "fixture-source.mp3", { lastModified: 0 });
let workers, owners, budget, validateCalls;
class FixtureWorker {
  constructor() { this.terminated = false; this.sent = []; workers.push(this); }
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  emit(value) {
    const start = this.sent.find((item) => item.kind === "start");
    if (!start) throw new Error("Missing synthetic Worker start");
    this.onmessage({ data: { abi: 1, id: start.id, ...value } });
  }
}
function reserve(bytes) {
  const owner = { held: 0, disposed: false, updates: [],
    update(next) {
      this.updates.push(next);
      if (this.disposed || next > budget) throw new Error("Synthetic admission refused.");
      this.held = next;
    },
    dispose() { owner.disposed = true; owner.held = 0; },
  };
  owner.update(bytes); owners.push(owner); return owner;
}
async function validate(candidate, signal) {
  validateCalls++;
  signal.throwIfAborted();
  const bytes = await candidate.arrayBuffer(), view = new DataView(bytes);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint16(34, true), 32);
  // Private synthetic PCM fixture, never a claim of actual codec fidelity.
  assert.equal(Object.is(view.getFloat32(44, true), -0), true);
  assert.equal(view.getFloat32(48, true), 1.25);
  return { canonical: new Blob([bytes], { type: "audio/wav" }),
    measurement: { sampleRate: 48000, frames: (bytes.byteLength - 44) / 8,
      sourceIdentity: { pcmHash: "b".repeat(64), sampleRate: 48000, frames: (bytes.byteLength - 44) / 8 } } };
}
async function started() {
  for (let count = 0; count < 50; count++) {
    const worker = workers[0];
    if (worker?.sent.some((message) => message.kind === "start")) return worker;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Synthetic Worker did not start");
}
function chunk(frames = 1) {
  const bytes = new ArrayBuffer(frames * 8), view = new DataView(bytes);
  for (let index = 0; index < frames; index++) { view.setFloat32(index * 8, -0, true); view.setFloat32(index * 8 + 4, 1.25, true); }
  return { kind: "chunk", sequence: 1, frames, rate: 48000, channels: 2, audio: bytes };
}
beforeEach(() => {
  workers = []; owners = []; budget = 512 * 1024 * 1024; validateCalls = 0;
  globalThis.Worker = FixtureWorker;
  globalThis.fetch = async () => new Response(JSON.stringify({
    abi: 1, status: "private-unqualified", distributionApproved: false, worker: workerName, assetBytes: 1024,
  }), { headers: { "Content-Type": "application/json" } });
});
afterEach(() => { globalThis.Worker = originalWorker; globalThis.fetch = originalFetch; globalThis.Blob = originalBlob; });

test("rejects invalid admission geometry and includes later Go allocation peak", () => {
  for (const frames of [0, -1, 16777217, Number.NaN]) assert.throws(() => recoveryPeakBytes(32, frames, 1024));
  assert.ok(recoveryPeakBytes(32, 1_000_000, 1024) > 64 * 1024 * 1024 + 8 * 1_000_000 * 8);
});
test("retains only the adapter-validated canonical result and ownership until disposal", async () => {
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2 });
  const worker = await started();
  worker.emit(chunk());
  assert.deepEqual(worker.sent.at(-1), { kind: "ack", abi: 1, id: worker.sent[0].id, sequence: 1 });
  worker.emit({ kind: "end", sequence: 1, frames: 1, rate: 48000, channels: 2 });
  const result = await promise;
  assert.equal(validateCalls, 1); assert.equal(worker.terminated, true);
  assert.equal(result.canonical.size, 52); assert.equal(owners[0].disposed, false);
  assert.equal("rawOriginal" in result, false); assert.equal("download" in result, false);
  result.dispose(); assert.equal(owners[0].disposed, true);
});
test("rejects a source beyond the pre-admitted output ceiling without invoking CDR", async () => {
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 1 });
  const rejected = assert.rejects(promise, /Invalid bounded/);
  const worker = await started(); worker.emit(chunk(2)); await rejected;
  assert.equal(validateCalls, 0); assert.equal(worker.terminated, true); assert.equal(owners[0].disposed, true);
});
test("rejects nonfinite PCM and drops all partial output", async () => {
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2 });
  const rejected = assert.rejects(promise, /Nonfinite/);
  const worker = await started(), data = chunk(); new DataView(data.audio).setFloat32(4, Infinity, true);
  worker.emit(data); await rejected;
  assert.equal(validateCalls, 0); assert.equal(owners[0].disposed, true);
});
test("cancels a busy Worker from its parent and accepts no late result", async () => {
  const controller = new AbortController();
  const promise = recoverCompressedFixture(file(), { signal: controller.signal, reserve, validate, maxFrames: 2 });
  const rejected = assert.rejects(promise, { name: "AbortError" });
  const worker = await started(); controller.abort(); await rejected;
  assert.equal(worker.terminated, true); assert.equal(validateCalls, 0); assert.equal(owners[0].disposed, true);
});
test("holds one operation, rejects concurrency and leaves the first cancelable", async () => {
  const controller = new AbortController();
  const first = recoverCompressedFixture(file(), { signal: controller.signal, reserve, validate, maxFrames: 2 });
  const rejected = assert.rejects(first, { name: "AbortError" });
  await started();
  await assert.rejects(recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2 }), /already active/);
  controller.abort(); await rejected; assert.equal(workers.length, 1);
});
test("low memory chooses an earlier frame ceiling and never publishes excess audio", async () => {
  budget = 256 * 1024 * 1024;
  const controller = new AbortController();
  const promise = recoverCompressedFixture(file(), { signal: controller.signal, reserve, validate });
  const rejected = assert.rejects(promise, { name: "AbortError" });
  const worker = await started();
  assert.ok(worker.sent[0].maxFrames < 16777216);
  assert.ok(owners[0].held <= budget);
  controller.abort(); await rejected; assert.equal(validateCalls, 0);
});

test("ignores queued Worker chunks after terminal EOF before CDR settles", async () => {
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2 });
  const worker = await started();
  worker.emit(chunk());
  worker.emit({ kind: "end", sequence: 1, frames: 1, rate: 48000, channels: 2 });
  const late = chunk(); late.sequence = 2;
  worker.emit(late);
  const result = await promise;
  assert.equal(validateCalls, 1); assert.equal(result.measurement.frames, 1);
  assert.equal(worker.sent.filter((message) => message.kind === "ack").length, 1);
  result.dispose(); assert.equal(owners[0].disposed, true);
});

test("copies many one-frame messages into at most two Blob parts", async () => {
  const partsSeen = [];
  globalThis.Blob = class extends originalBlob {
    constructor(parts, options) { partsSeen.push(parts.length); super(parts, options); }
  };
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2048 });
  const worker = await started();
  for (let sequence = 1; sequence <= 1024; sequence++) {
    const data = chunk(); data.sequence = sequence; worker.emit(data);
  }
  worker.emit({ kind: "end", sequence: 1024, frames: 1024, rate: 48000, channels: 2 });
  const result = await promise;
  try {
    assert.equal(result.canonical.size, 44 + 1024 * 8);
    assert.equal(partsSeen[0], 2);
    assert.equal(worker.sent.filter((message) => message.kind === "ack").length, 1024);
  } finally { result.dispose(); }
});
test("rejects zero-length manifest chunks before consulting another read", async () => {
  let reads = 0, canceled = 0;
  globalThis.fetch = async () => ({ ok: true, body: { getReader: () => ({
    async read() {
      if (++reads === 1) return { done: false, value: new Uint8Array(0) };
      throw new Error("An unbounded manifest reader was consulted.");
    },
    async cancel() { canceled++; },
    releaseLock() {},
  }) } });
  await assert.rejects(recoverCompressedFixture(file(), {
    signal: new AbortController().signal, reserve, validate, maxFrames: 2,
  }), /empty.*chunk|chunk.*empty/i);
  assert.equal(reads, 1); assert.equal(canceled, 1);
  assert.equal(workers.length, 0); assert.equal(owners[0].disposed, true);
});
test("admits the exact largest frame ceiling with at most 25 atomic probes", async () => {
  budget = recoveryPeakBytes(32, 10000, 32 * 1024 * 1024);
  const controller = new AbortController();
  const promise = recoverCompressedFixture(file(), { signal: controller.signal, reserve, validate, maxFrames: 30000 });
  const rejected = assert.rejects(promise, /Invalid bounded/);
  const worker = await started();
  const selected = worker.sent[0].maxFrames;
  const probes = owners[0].updates.length - 1;
  // Settle the operation even when the capacity assertion exposes a regression.
  const data = chunk(selected + 1); worker.emit(data); await rejected;
  assert.equal(selected, 10000); assert.ok(probes <= 25);
  assert.ok(owners[0].updates.some((bytes) => bytes > budget));
  assert.equal(owners[0].disposed, true); assert.equal(validateCalls, 0);
});

test("discards an accepted PCM prefix on Worker error without constructing a Blob or invoking CDR", async () => {
  let blobs = 0;
  globalThis.Blob = class extends originalBlob {
    constructor(parts, options) { blobs++; super(parts, options); }
  };
  const promise = recoverCompressedFixture(file(), { signal: new AbortController().signal, reserve, validate, maxFrames: 2 });
  const rejected = assert.rejects(promise, /outside this private recovery profile/);
  const worker = await started();
  worker.emit(chunk());
  assert.equal(worker.sent.filter((message) => message.kind === "ack").length, 1);
  worker.emit({ kind: "error", error: "Synthetic later AVIO failure." });
  worker.emit({ kind: "end", sequence: 1, frames: 1, rate: 48000, channels: 2 });
  await rejected;
  assert.equal(blobs, 0); assert.equal(validateCalls, 0);
  assert.equal(worker.terminated, true); assert.equal(owners[0].disposed, true);
});
