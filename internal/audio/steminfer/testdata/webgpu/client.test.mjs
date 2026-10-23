import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ABI, SHADER_SHA256, shapePlan, parseFixture } from "./contract.mjs";
import { probeGPU, runFixture } from "./client.mjs";
const originalWorker = globalThis.Worker;
class WorkerMock {
  static all = [];
  constructor(url, options) { assert.match(String(url), /\/worker\.mjs$/);assert.equal(options.type, "module");WorkerMock.all.push(this);this.terminations = 0; }
  terminate() { this.terminations++; }
  postMessage(message, transfer) { this.message = structuredClone(message, { transfer }); }
  reply(report = { shaderSHA256: SHADER_SHA256, dispatched: false }) { this.onmessage?.({ data: { abi: ABI, id: this.message.id, kind: "result", report } }); }
}
beforeEach(() => { WorkerMock.all = [];globalThis.Worker = WorkerMock; });
afterEach(() => { globalThis.Worker = originalWorker; });
function zeroFixture() {
  const p = shapePlan(1, 1, 1), buffer = new ArrayBuffer(p.fixtureBytes), v = new DataView(buffer);
  new Uint8Array(buffer, 0, 8).set(new TextEncoder().encode("AUGEMM01"));v.setUint32(8, 1, true);v.setUint32(12, 1, true);v.setUint32(16, 1, true);
  return parseFixture(buffer);
}
test("only literal private module and matching ABI/ID can settle a probe", async () => {
  const run = probeGPU();WorkerMock.all[0].reply();assert.equal((await run).dispatched, false);assert.ok(WorkerMock.all[0].terminations);
  const bad = probeGPU();const worker = WorkerMock.all[1];worker.onmessage({ data: { abi: ABI, id: "wrong", kind: "result" } });await assert.rejects(bad, /identity/);
});
test("a result must preserve shader pin, canaries, plan and exact finite geometry", async () => {
  const fixture = zeroFixture(), promise = runFixture(fixture), worker = WorkerMock.all[0];
  assert.equal(worker.message.a.byteLength, 4);assert.equal(fixture.a.byteLength, 4);
  worker.reply({ shaderSHA256: SHADER_SHA256, dispatched: true, result: Float32Array.of(0).buffer, canariesIntact: true,
    chargedApplicationBufferBytes: fixture.plan.chargedBytes, paddedMultiplyAdds: fixture.plan.paddedWork });
  assert.equal((await promise).comparison.normalViolations, 0);
  const failed = runFixture(fixture);WorkerMock.all[1].reply({ shaderSHA256: "changed", dispatched: true });await assert.rejects(failed, /unpinned/);
});
test("one active fixture has no waiting queue and abort releases its worker", async () => {
  const controller = new AbortController(), run = probeGPU(controller.signal);
  await assert.rejects(probeGPU(), /already active/);assert.equal(WorkerMock.all.length, 1);
  controller.abort();await assert.rejects(run, { name: "AbortError" });assert.ok(WorkerMock.all[0].terminations);
  const next = probeGPU();WorkerMock.all[1].reply();await next;
});
test("failed private snapshot clone allocates no worker and permits the next fixture", async () => {
  const fixture = zeroFixture(), original = ArrayBuffer.prototype.slice;
  ArrayBuffer.prototype.slice = () => { throw new Error("clone rejected"); };
  try { await assert.rejects(runFixture(fixture), /clone rejected/);assert.equal(WorkerMock.all.length, 0); }
  finally { ArrayBuffer.prototype.slice = original; }
  const next = probeGPU();WorkerMock.all[0].reply();await next;
});
test("caller mutations after publication cannot alter the private comparison", async () => {
  const fixture = zeroFixture(), promise = runFixture(fixture), worker = WorkerMock.all[0];
  fixture.a[0] = 999;
  fixture.view.setFloat64(fixture.expectedOffset, 999, true);
  assert.equal(new Float32Array(worker.message.a)[0], 0);
  worker.reply({ shaderSHA256: SHADER_SHA256, dispatched: true, result: Float32Array.of(0).buffer, canariesIntact: true,
    chargedApplicationBufferBytes: fixture.plan.chargedBytes, paddedMultiplyAdds: fixture.plan.paddedWork });
  assert.equal((await promise).comparison.normalViolations, 0);
});
test("fixed deadline terminates without claiming GPU preemption", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = probeGPU();t.mock.timers.tick(5000);t.mock.timers.tick(50);await assert.rejects(run, /preemption is not guaranteed/);assert.ok(WorkerMock.all[0].terminations);
});
