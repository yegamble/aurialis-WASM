import { test } from "node:test";
import assert from "node:assert/strict";
import { ABI, shapePlan, validateRequest, validateDevice, parseFixture, compareFixture } from "./contract.mjs";
const request = (m = 1, n = 1, k = 1) => ({ abi: ABI, id: "test-1", kind: "matmul", m, n, k, a: new ArrayBuffer(m * k * 4), b: new ArrayBuffer(n * k * 4) });
test("closed s64 ABI excludes extra modes, unsafe shapes and wrong lengths", () => {
  assert.equal(validateRequest(request()).cElements, 1);
  for (const message of [{ ...request(), flags: 0 }, { ...request(), alpha: 1 }, { ...request(), inner: 1 }, { ...request(), abi: "old" }, { ...request(), id: "bad/id" }, { ...request(), kind: "other" }, { ...request(), a: new ArrayBuffer(0) }]) assert.throws(() => validateRequest(message));
  for (const shape of [[0, 1, 1], [1.5, 1, 1], [1, 1, Infinity], [2 ** 32, 1, 1], [1, 1, 2049]]) assert.throws(() => shapePlan(...shape));
});
test("padded work and CPU work are bounded independently of memory", () => {
  assert.equal(shapePlan(1, 1, 2048).paddedWork, 8_388_608);
  assert.throws(() => shapePlan(65, 65, 2048), /work/);
  assert.throws(() => shapePlan(256, 256, 256), /work/);
  assert.throws(() => shapePlan(512, 1024, 1), /16 MiB/);
  for (const m of [1, 63, 64, 65]) for (const n of [1, 63, 64, 65]) for (const k of [1, 15, 16, 17]) {
    const p = shapePlan(m, n, k); assert.ok(p.chargedBytes <= 16 * 1024 * 1024); assert.equal(p.cElements, m * n);
  }
});
test("nonfinite and conservative overflow operands fail before device allocation", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const r = request(); new Float32Array(r.a)[0] = value; assert.throws(() => validateRequest(r), /Nonfinite/);
  }
  const r = request(); new Float32Array(r.a)[0] = 1e30; new Float32Array(r.b)[0] = 1e30;
  assert.throws(() => validateRequest(r), /overflow/);
});
test("device checks fail closed on missing storage or workgroup capability", () => {
  const limits = { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupStorageSize: 16384, maxComputeWorkgroupsPerDimension: 65535, maxStorageBuffersPerShaderStage: 8, maxBindingsPerBindGroup: 1000,
    maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 };
  validateDevice(shapePlan(65, 63, 17), limits);
  assert.throws(() => validateDevice(shapePlan(65, 63, 17), {}));
  assert.throws(() => validateDevice(shapePlan(65, 63, 17), { ...limits, maxBufferSize: NaN }));
  for (const field of Object.keys(limits)) assert.throws(() => validateDevice(shapePlan(65, 63, 17), { ...limits, [field]: 0 }));
});
function fixture(a, b) {
  const p = shapePlan(1, 1, a.length), buffer = new ArrayBuffer(p.fixtureBytes), v = new DataView(buffer);
  new Uint8Array(buffer, 0, 8).set(new TextEncoder().encode("AUGEMM01"));v.setUint32(8, 1, true);v.setUint32(12, 1, true);v.setUint32(16, a.length, true);
  new Float32Array(buffer, 24, a.length).set(a);new Float32Array(buffer, 24 + p.aBytes, b.length).set(b);
  const av = new Float32Array(buffer, 24, a.length), bv = new Float32Array(buffer, 24 + p.aBytes, b.length);
  let sum = 0, sumabs = 0, f32 = 0;
  for (let i = 0; i < a.length; i++) { sum += av[i] * bv[i]; sumabs += Math.abs(av[i] * bv[i]); f32 = Math.fround(f32 + Math.fround(av[i] * bv[i])); }
  v.setFloat64(24 + p.aBytes + p.bBytes, sum, true);v.setFloat64(32 + p.aBytes + p.bBytes, sumabs, true);v.setFloat32(40 + p.aBytes + p.bBytes, f32, true);
  return parseFixture(buffer);
}
test("comparison preserves cancellation-sensitive absolute bounds and rejects wrong finite results", () => {
  const f = fixture([1, 1e-6, -1], [1, 1, 1]);
  assert.equal(compareFixture(f, Float32Array.of(1e-6)).normalViolations, 0);
  assert.throws(() => compareFixture(f, Float32Array.of(1e-3)), /exceeds/);
  assert.throws(() => compareFixture(f, Float32Array.of(NaN)), /Nonfinite/);
});
test("subnormal flushing is separately disclosed, never promoted to normal conformance", () => {
  const f = fixture([1e-40], [1e30]);
  assert.equal(compareFixture(f, Float32Array.of(0)).denormalOnlyViolations, 1);
  assert.match(compareFixture(f, Float32Array.of(0)).verdict, /not normal/);
});

test("forged finite reference values and inflated sumabs cannot manufacture conformance", () => {
  const f = fixture([1, 2], [3, 4]);
  f.view.setFloat64(f.sumOffset, 1e30, true);
  assert.throws(() => compareFixture(f, Float32Array.of(999)), /Saved Go reference disagrees/);
  const g = fixture([1], [2]);g.view.setFloat64(g.expectedOffset, 999, true);
  assert.throws(() => compareFixture(g, Float32Array.of(999)), /Saved Go reference disagrees/);
});
