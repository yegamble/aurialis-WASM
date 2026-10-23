/** Private fixture ABI only. No model, app import or network operation. */
export const ABI = "aurialis-private-gemm-1";
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_PADDED_WORK = 8_388_608;
export const MAX_REFERENCE_WORK = 2_097_152;
export const MAX_DIMENSION = 2048;
export const SHADER_SHA256 = "a4f41fc6513f6141879ef0a7df1b8e689c32acb55cdbf654ec7019efbcc9657d";
const U32_MAX = 0xffff_ffff;
const MAX_FLOAT32 = 3.4028234663852886e38;
const MIN_NORMAL = 2 ** -126;

function safe(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) throw new Error(`Unsafe ${label}`);
  return value;
}
export function shapePlan(m, n, k) {
  for (const [name, value] of [["m", m], ["n", n], ["k", k]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) throw new Error(`Unsupported ${name}`);
  }
  const aElements = safe(m * k, "A elements"), bElements = safe(n * k, "B elements"), cElements = safe(m * n, "C elements");
  // Prefix and suffix canaries are fixed by this ABI, never caller offsets.
  safe(aElements + 1, "A final index"); safe(bElements + 1, "B final index"); safe(cElements + 1, "C final index");
  const x = Math.ceil(n / 64), y = Math.ceil(m / 64);
  const paddedWork = safe(x * y * 4096 * Math.ceil(k / 16) * 16, "padded multiply-adds");
  const referenceWork = safe(m * n * k, "reference multiply-adds");
  if (paddedWork > MAX_PADDED_WORK || referenceWork > MAX_REFERENCE_WORK) throw new Error("Fixture work exceeds its limit");
  const aBytes = safe(aElements * 4, "A bytes"), bBytes = safe(bElements * 4, "B bytes"), cBytes = safe(cElements * 4, "C bytes");
  // Five input copies: caller file, immutable private snapshot, transfer clone,
  // GPU and upload staging. Sixteen output copies cover the caller+snapshot
  // F64 reference/sumabs + F32 diagnostic, initialization, GPU/readback and mapping.
  // This bounds declared application buffers, not opaque driver/device overhead.
  const chargedBytes = 5 * (aBytes + bBytes) + 16 * cBytes + 4096;
  if (!Number.isSafeInteger(chargedBytes) || chargedBytes > MAX_BUFFER_BYTES) throw new Error("Fixture buffers exceed 16 MiB");
  return Object.freeze({ m, n, k, aElements, bElements, cElements, aBytes, bBytes, cBytes, chargedBytes, paddedWork, referenceWork, x, y,
    fixtureBytes: 24 + aBytes + bBytes + cElements * 20 });
}
function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) throw new Error("Invalid fixture fields");
}
export function validateIdentity(message) {
  if (!message || message.abi !== ABI || typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/u.test(message.id)) throw new Error("Invalid private fixture identity");
}
export function validateRequest(message) {
  validateIdentity(message);
  if (message.kind === "probe") { exactKeys(message, ["abi", "id", "kind"]); return null; }
  exactKeys(message, ["abi", "id", "kind", "m", "n", "k", "a", "b"]);
  if (message.kind !== "matmul") throw new Error("Unsupported private fixture operation");
  const plan = shapePlan(message.m, message.n, message.k);
  if (!(message.a instanceof ArrayBuffer) || !(message.b instanceof ArrayBuffer)
    || message.a.byteLength !== plan.aBytes || message.b.byteLength !== plan.bBytes) throw new Error("Invalid fixture operand layout");
  validateOperands(plan, new Float32Array(message.a), new Float32Array(message.b));
  return plan;
}
export function validateOperands(plan, a, b) {
  if (!(a instanceof Float32Array) || !(b instanceof Float32Array) || a.length !== plan.aElements || b.length !== plan.bElements) throw new Error("Invalid fixture operand views");
  let maxA = 0, maxB = 0;
  for (const [buffer, which] of [[a, "A"], [b, "B"]]) {
    let maximum = 0;
    for (const value of buffer) {
      if (!Number.isFinite(value)) throw new Error("Nonfinite fixture operand");
      maximum = Math.max(maximum, Math.abs(value));
    }
    if (which === "A") maxA = maximum; else maxB = maximum;
  }
  // Bound every possible partial dot conservatively; no cancellation exemption.
  if (maxA * maxB * plan.k > MAX_FLOAT32 / 2) throw new Error("Fixture could overflow Float32");
}
export function validateDevice(plan, limits) {
  if (!plan) return;
  for (const field of ["maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupStorageSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage", "maxBindingsPerBindGroup", "maxBufferSize", "maxStorageBufferBindingSize"]) {
    if (!Number.isSafeInteger(limits?.[field]) || limits[field] < 1) throw new Error("Missing or invalid device limit");
  }
  if (limits.maxComputeInvocationsPerWorkgroup < 256 || limits.maxComputeWorkgroupSizeX < 16 || limits.maxComputeWorkgroupSizeY < 16
    || limits.maxComputeWorkgroupSizeZ < 1 || limits.maxComputeWorkgroupStorageSize < 8320
    || limits.maxComputeWorkgroupsPerDimension < Math.max(plan.x, plan.y)
    || limits.maxStorageBuffersPerShaderStage < 4 || limits.maxBindingsPerBindGroup < 5
    || Math.max(plan.aBytes + 8, plan.bBytes + 8, plan.cBytes + 8, 96) > limits.maxBufferSize
    || Math.max(plan.aBytes + 8, plan.bBytes + 8, plan.cBytes + 8) > limits.maxStorageBufferBindingSize) throw new Error("Device limits do not support this fixture");
}
export function parseFixture(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("Invalid fixture file size");
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== "AUGEMM01" || view.getUint32(20, true) !== 0) throw new Error("Invalid fixture header");
  const plan = shapePlan(view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true));
  if (buffer.byteLength !== plan.fixtureBytes) throw new Error("Fixture byte count changed");
  const a = new Float32Array(buffer, 24, plan.aElements), b = new Float32Array(buffer, 24 + plan.aBytes, plan.bElements);
  const expectedOffset = 24 + plan.aBytes + plan.bBytes, sumOffset = expectedOffset + plan.cElements * 8, f32Offset = sumOffset + plan.cElements * 8;
  return Object.freeze({ plan, a, b, view, expectedOffset, sumOffset, f32Offset });
}
export function compareFixture(fixture, output) {
  const { plan, view, expectedOffset, sumOffset, f32Offset, a, b } = fixture;
  if (!(output instanceof Float32Array) || output.length !== plan.cElements) throw new Error("Invalid fixture result layout");
  const u = 2 ** -24, gamma = 2 * plan.k * u / (1 - 2 * plan.k * u);
  let maximumAbsoluteError = 0, maximumF32Difference = 0, normalViolations = 0, denormalOnlyViolations = 0;
  for (let row = 0; row < plan.m; row++) for (let col = 0; col < plan.n; col++) {
    const i = row * plan.n + col, actual = output[i], expected = view.getFloat64(expectedOffset + i * 8, true), sumabs = view.getFloat64(sumOffset + i * 8, true), diagnostic = view.getFloat32(f32Offset + i * 4, true);
    if (![actual, expected, sumabs, diagnostic].every(Number.isFinite) || sumabs < 0) throw new Error("Nonfinite or invalid fixture comparison");
    let flushAllowance = MIN_NORMAL * (2 * plan.k + 1);
    let independent = 0, correction = 0, independentAbs = 0, absCorrection = 0, rounded = 0;
    for (let index = 0; index < plan.k; index++) {
      const av = a[row * plan.k + index], bv = b[col * plan.k + index], product = av * bv;
      const adjusted = product - correction, next = independent + adjusted;
      correction = (next - independent) - adjusted; independent = next;
      const absAdjusted = Math.abs(product) - absCorrection, absNext = independentAbs + absAdjusted;
      absCorrection = (absNext - independentAbs) - absAdjusted; independentAbs = absNext;
      rounded = Math.fround(rounded + Math.fround(product));
      if ((av !== 0 && Math.abs(av) < MIN_NORMAL) || (bv !== 0 && Math.abs(bv) < MIN_NORMAL) || Math.abs(product) < MIN_NORMAL) flushAllowance += Math.abs(product);
    }
    // Never let edited file-provided references or an inflated sumabs grant a pass.
    if (independent !== expected || independentAbs !== sumabs || rounded !== diagnostic) throw new Error("Saved Go reference disagrees with independent exact-input dot");
    const error = Math.abs(actual - independent);
    // Cancellation uses sumabs, not output-relative error. These are diagnostic
    // bounds, not universal GPU or whole-model arithmetic guarantees.
    const standardBound = gamma * independentAbs + Number.EPSILON * plan.k * independentAbs + 2 ** -149 * (2 * plan.k + 1);
    if (error > standardBound) {
      normalViolations++;
      if (error > standardBound + flushAllowance) throw new Error(`GEMM error exceeds declared diagnostic bound at ${row},${col}`);
      denormalOnlyViolations++;
    }
    maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
    maximumF32Difference = Math.max(maximumF32Difference, Math.abs(actual - diagnostic));
  }
  return { maximumAbsoluteError, maximumF32Difference, normalViolations, denormalOnlyViolations,
    verdict: normalViolations ? "denormal-limited diagnostic; not normal-arithmetic conformance" : "within declared Float32 dot diagnostic bound",
    bound: "gamma(2K)*sumabs + eps64*K*sumabs + (2K+1)*2^-149; separately reported input/product flush allowance" };
}
