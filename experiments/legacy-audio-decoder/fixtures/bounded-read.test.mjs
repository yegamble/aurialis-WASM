/* Fixed-buffer fetch units only. No browser network, decoder or Go CDR. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoundedResponse } from "../bounded-read.mjs";

function stream(parts) {
  let reads = 0, canceled = 0, released = 0;
  return { response: { ok: true, body: { getReader: () => ({
    async read() { const value = parts[reads++]; return value === undefined ? { done: true } : { done: false, value }; },
    async cancel() { canceled++; },
    releaseLock() { released++; },
  }) } }, counts: () => ({ reads, canceled, released }) };
}
test("copies tiny pieces into one fixed-capacity buffer and returns only actual bytes", async () => {
  const parts = Array.from({ length: 32 }, (_, index) => new Uint8Array([index]));
  const fixture = stream(parts);
  const result = await readBoundedResponse(fixture.response, { maxBytes: 64, maxReads: 32 });
  assert.equal(result.buffer.byteLength, 64); assert.equal(result.byteLength, 32);
  assert.deepEqual(Array.from(result), Array.from({ length: 32 }, (_, index) => index));
  assert.deepEqual(fixture.counts(), { reads: 33, canceled: 0, released: 1 });
});
test("rejects an empty chunk immediately and cancels rather than retaining or polling it", async () => {
  const fixture = stream([new Uint8Array(0), new Uint8Array([1])]);
  await assert.rejects(readBoundedResponse(fixture.response, { maxBytes: 64, maxReads: 32 }), /empty chunk/);
  assert.deepEqual(fixture.counts(), { reads: 1, canceled: 1, released: 1 });
});
test("caps tiny-piece read work even when the byte capacity has not been reached", async () => {
  const fixture = stream(Array.from({ length: 32 }, () => new Uint8Array([1])));
  await assert.rejects(readBoundedResponse(fixture.response, { maxBytes: 64, maxReads: 3 }), /read-count limit/);
  assert.deepEqual(fixture.counts(), { reads: 4, canceled: 1, released: 1 });
});
test("rejects byte overflow and a wholly empty asset", async () => {
  const overflow = stream([new Uint8Array(4), new Uint8Array(1)]);
  await assert.rejects(readBoundedResponse(overflow.response, { maxBytes: 4, maxReads: 4 }), /byte bound/);
  assert.deepEqual(overflow.counts(), { reads: 2, canceled: 1, released: 1 });
  const empty = stream([]);
  await assert.rejects(readBoundedResponse(empty.response, { maxBytes: 4, maxReads: 4 }), /asset is empty/);
  assert.equal(empty.counts().canceled, 1);
});
test("rechecks cancellation after a late read before copying or returning data", async () => {
  let resolveRead, stopped = false, canceled = 0;
  const response = { ok: true, body: { getReader: () => ({
    read: () => new Promise((resolve) => { resolveRead = resolve; }),
    async cancel() { canceled++; },
    releaseLock() {},
  }) } };
  const promise = readBoundedResponse(response, {
    maxBytes: 4, maxReads: 4, check: () => { if (stopped) throw new Error("Stopped fixture."); },
  });
  const rejected = assert.rejects(promise, /Stopped fixture/);
  stopped = true; resolveRead({ done: false, value: new Uint8Array([1]) });
  await rejected; assert.equal(canceled, 1);
});
