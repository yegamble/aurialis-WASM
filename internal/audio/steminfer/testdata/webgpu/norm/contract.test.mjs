import { test } from "node:test";
import assert from "node:assert/strict";
import { ABI, shapePlan, parseFixture, validateOperands, validateRequest, validateDevice, compareFixture, MIN_NORMAL } from "./contract.mjs";
import { fixture, stages } from "./test-helpers.mjs";
test("closed shape, byte and padded work caps precede worker allocation", () => {
  for (const rows of [1, 3, 63, 64, 65, 255, 256, 257, 310, 512]) { const plan = shapePlan(rows); assert.ok(plan.chargedBytes < 16 * 1024 * 1024); assert.ok(plan.paddedWork <= 1_572_864); }
  for (const rows of [0, 1.5, NaN, Infinity, 513, 2 ** 32]) assert.throws(() => shapePlan(rows));
  assert.throws(() => shapePlan(1, 255));
  const f = fixture(), request = { abi: ABI, id: "fixture-1", kind: "normalize", fixture: f.view.buffer };
  assert.equal(validateRequest(request).plan.rows, 1);
  for (const message of [{ ...request, epsilon: 1e-12 }, { ...request, kind: "norm" }, { ...request, id: "bad/id" }, { ...request, fixture: new ArrayBuffer(24) }]) assert.throws(() => validateRequest(message));
});
test("nonfinite/overflow and unbounded gamma fail before any device", () => {
  for (const value of [NaN, Infinity, -Infinity, 1e30]) { const f = fixture(); f.x[0] = value; assert.throws(() => validateOperands(f)); }
  for (const value of [NaN, Infinity, 33]) { const f = fixture(); f.gamma[0] = value; assert.throws(() => validateOperands(f)); }
});
test("all needed workgroup/storage and readback limits fail closed", () => {
  const limits = { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 1, maxComputeWorkgroupSizeZ: 1, maxComputeWorkgroupStorageSize: 1028,
    maxComputeWorkgroupsPerDimension: 64, maxStorageBuffersPerShaderStage: 5, maxBindingsPerBindGroup: 6, maxBufferSize: 2 ** 24, maxStorageBufferBindingSize: 2 ** 24 };
  validateDevice(shapePlan(257), limits);
  for (const field of Object.keys(limits)) assert.throws(() => validateDevice(shapePlan(257), { ...limits, [field]: 0 }));
  assert.throws(() => validateDevice(shapePlan(257), {}));
});
test("both actual reference diagnostics remain separate and corrupted Go references fail", () => {
  const x = Float32Array.from({ length: 3 * 256 }, (_, i) => (i % 31 - 15) / 16), gamma = new Float32Array(256).fill(0.75), f = fixture(x, gamma, 3);
  const result = stages(f), report = compareFixture(f, result); assert.equal(report.underflowLimitedElements, 0); assert.equal(report.ordinaryElements, 768);
  assert.ok(Number.isFinite(report.maximumGoDifference)); assert.ok(Number.isFinite(report.maximumTorchDifference));
  f.view.setFloat64(f.goNormOffset, 1e30, true); assert.throws(() => compareFixture(f, result), /Saved Go norm/);
  const zero = fixture(); zero.go[0] = 999; assert.throws(() => compareFixture(zero, stages(zero)), /Saved Go output/);
});
test("actual stored denominator, quotient and final stage have independent guards", () => {
  const x = new Float32Array(256).fill(1), f = fixture(x, new Float32Array(256).fill(1));
  for (const offset of [0, f.plan.xBytes, 2 * f.plan.xBytes]) { const result = stages(f); new DataView(result).setFloat32(offset, 999, true); assert.throws(() => compareFixture(f, result), /exceeds/); }
  const result = stages(f); new DataView(result).setFloat32(0, NaN, true); assert.throws(() => compareFixture(f, result), /nonfinite/);
});
test("reviewer quotient-rounding amplification defeats the rejected fixed-minsub floor", () => {
  const x = new Float32Array(256); x[0] = 2 ** -103; x[1] = 3 * 2 ** 30;
  const f = fixture(x, new Float32Array(256).fill(32)), result = stages(f), output = new Float32Array(result, f.plan.xBytes, 256);
  const ideal = x[0] / (3 * 2 ** 30) * 16 * 32, u = 2 ** -24, oldBound = 32 * u / (1 - 32 * u) * Math.abs(ideal) + 4 * 2 ** -149;
  assert.ok(Math.abs(output[0] - ideal) > oldBound, "independent counterexample must retain the rejected bound failure");
  const report = compareFixture(f, result); assert.ok(report.underflowLimitedElements > 0); assert.match(report.verdict, /not whole-fixture/);
});
test("pass2 reassociation/FTZ is limited even when final ideal output is normal", () => {
  const x = new Float32Array(256); x[0] = 0.125; x[1] = 1;
  const f = fixture(x, new Float32Array(256).fill(MIN_NORMAL)), result = stages(f), output = new Float32Array(result, f.plan.xBytes, 256);
  assert.ok(output[0] >= MIN_NORMAL); output[0] = 0; const report = compareFixture(f, result); assert.ok(report.underflowLimitedElements > 0); assert.ok(report.maximumGoDifference >= MIN_NORMAL);
  output[0] = 0.1; assert.throws(() => compareFixture(f, result), /scale exceeds/);
});
test("normal squares with a flushed subnormal quotient stay explicitly limited", () => {
  const x = new Float32Array(256).fill(7e17); x[0] = 2 ** -63;
  assert.equal(x[0] * x[0], MIN_NORMAL, "tiny input square is exactly the smallest normal");
  const f = fixture(x, new Float32Array(256).fill(32)), result = stages(f), q = new Float32Array(result, 0, 256), output = new Float32Array(result, f.plan.xBytes, 256);
  const exact = x[0] / new Float32Array(result, 2 * f.plan.xBytes, 1)[0];
  assert.ok(exact > 0 && exact < MIN_NORMAL, "input/divisor is subnormal despite all normal squares");
  assert.ok(output[0] >= MIN_NORMAL, "post-division scaling amplifies quotient to normal range");
  q[0] = 0; output[0] = 0;
  const report = compareFixture(f, result);
  assert.equal(report.underflowLimitedElements, 1, "observed flushed zero must not manufacture ordinary conformance");
  assert.match(report.verdict, /not whole-fixture/);
});
