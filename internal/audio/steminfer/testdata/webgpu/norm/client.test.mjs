import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ABI, SHADER_SHA256 } from "./contract.mjs";
import { FIXTURE_SHA256 } from "./fixture-index.mjs";
import { probeGPU, runFixture } from "./client.mjs";
import { fixture, stages } from "./test-helpers.mjs";
const originalWorker = globalThis.Worker;
class WorkerMock {
  static all = [];
  constructor(url, options) { assert.match(String(url), /\/worker\.mjs$/u); assert.equal(options.type, "module"); WorkerMock.all.push(this); this.terminations = 0; }
  terminate() { this.terminations++; }
  postMessage(message, transfer) { this.message = structuredClone(message, { transfer }); }
  reply(report = { shaderSHA256: SHADER_SHA256, dispatched: false }) { this.onmessage?.({ data: { abi: ABI, id: this.message.id, kind: "result", report } }); }
}
beforeEach(() => { WorkerMock.all = []; globalThis.Worker = WorkerMock; });
afterEach(() => { globalThis.Worker = originalWorker; });
function report(f) { return { shaderSHA256: SHADER_SHA256, fixtureSHA256: FIXTURE_SHA256[0], dispatched: true, passes: 2, result: stages(f), canariesIntact: true, chargedApplicationBufferBytes: f.plan.chargedBytes, paddedWork: f.plan.paddedWork }; }
test("literal same-origin worker and exact ABI/ID guard the result", async () => {
  const run = probeGPU(); WorkerMock.all[0].reply(); assert.equal((await run).dispatched, false);
  const bad = probeGPU(); const worker = WorkerMock.all[1]; worker.onmessage({ data: { abi: ABI, id: "wrong", kind: "result" } }); await assert.rejects(bad, /identity/);
});
test("caller mutation cannot alter transferred snapshot or comparison authority", async () => {
  const f = fixture(), result = report(f), pending = runFixture(f), worker = WorkerMock.all[0];
  f.x[0] = 999; f.go[0] = 999; assert.equal(new Float32Array(worker.message.fixture, 24, 1)[0], 0);
  worker.reply(result); assert.equal((await pending).comparison.maximumGoDifference, 0);
});
test("unknown fixture hash, omitted stage, changed canary or shader fails", async () => {
  for (const change of [{ fixtureSHA256: "0".repeat(64) }, { passes: 1 }, { canariesIntact: false }, { shaderSHA256: "changed" }, { result: new ArrayBuffer(0) }]) {
    const f = fixture(), pending = runFixture(f); WorkerMock.all.at(-1).reply({ ...report(f), ...change }); await assert.rejects(pending);
  }
});
test("one active/noqueue and preallocation overflow refusal", async () => {
  const control = new AbortController(), pending = probeGPU(control.signal); await assert.rejects(probeGPU(), /already active/); control.abort(); await assert.rejects(pending, { name: "AbortError" });
  const f = fixture(); f.x[0] = 1e30; const before = WorkerMock.all.length; await assert.rejects(runFixture(f), /overflow/); assert.equal(WorkerMock.all.length, before);
});
test("snapshot failure owns no worker and releases the one-entry gate", async () => {
  const original = ArrayBuffer.prototype.slice; ArrayBuffer.prototype.slice = () => { throw new Error("clone rejected"); };
  try { await assert.rejects(runFixture(fixture()), /clone rejected/); assert.equal(WorkerMock.all.length, 0); } finally { ArrayBuffer.prototype.slice = original; }
  const next = probeGPU(); WorkerMock.all[0].reply(); await next;
});
test("deadline hard-terminates with no GPU preemption assertion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = probeGPU(); t.mock.timers.tick(5000); t.mock.timers.tick(50);
  await assert.rejects(pending, /preemption is not guaranteed/); assert.ok(WorkerMock.all[0].terminations);
});
