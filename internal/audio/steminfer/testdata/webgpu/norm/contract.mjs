/** Private two-pass L2*sqrt256 normalization fixture, never a model/app ABI. */
export const SHADER_SHA256 = "8de4e47e1c6f6ff05006434a9d731c799f2c9f08a9112d636807771205df177a";
export const ABI = "aurialis-private-rmsnorm256-1";
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const WIDTH = 256;
export const MAX_ROWS = 512;
export const MIN_NORMAL = 2 ** -126;
const MIN_SUBNORMAL = 2 ** -149;
const MAX_FLOAT32 = 3.4028234663852886e38;
const U = 2 ** -24;
const EPSILON = Math.fround(1e-12);
const GAMMA9 = 9 * U / (1 - 9 * U);
export function shapePlan(rows, width = WIDTH) {
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_ROWS || width !== WIDTH) throw new Error("Unsupported normalization shape");
  const elements = rows * WIDTH, xBytes = elements * 4, gammaBytes = WIDTH * 4;
  const x = 64, y = Math.ceil(rows / x), paddedRows = x * y;
  // Includes caller file + private snapshot + worker transfer + WebCrypto input,
  // Go/Torch reference bytes, CPU initialization, GPU/upload/readback/mapping,
  // and returned result copies. Opaque driver/device overhead is not measured.
  const chargedBytes = 30 * xBytes + 12 * gammaBytes + 64 * rows + 8192;
  const referenceWork = elements * 12, paddedWork = paddedRows * WIDTH * 12;
  if (![elements + 1, xBytes, chargedBytes, referenceWork, paddedWork].every(Number.isSafeInteger)
    || chargedBytes > MAX_BUFFER_BYTES || referenceWork > 1_572_864 || paddedWork > 1_572_864 || elements + 1 > 0xffff_ffff) throw new Error("Normalization resource cap exceeded");
  return Object.freeze({ rows, width, elements, xBytes, gammaBytes, x, y, chargedBytes, referenceWork, paddedWork,
    fixtureBytes: 24 + 3 * xBytes + gammaBytes + 12 * rows, resultBytes: 2 * xBytes + 4 * rows });
}
export function parseFixture(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("Invalid normalization fixture size");
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== "AUNORM01" || view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) throw new Error("Invalid normalization fixture header");
  const plan = shapePlan(view.getUint32(8, true), view.getUint32(12, true));
  if (buffer.byteLength !== plan.fixtureBytes) throw new Error("Normalization fixture byte count changed");
  let offset = 24;
  const x = new Float32Array(buffer, offset, plan.elements); offset += plan.xBytes;
  const gamma = new Float32Array(buffer, offset, WIDTH); offset += plan.gammaBytes;
  const go = new Float32Array(buffer, offset, plan.elements); offset += plan.xBytes;
  const goNormOffset = offset; offset += 8 * plan.rows;
  const torch = new Float32Array(buffer, offset, plan.elements); offset += plan.xBytes;
  const torchNorm = new Float32Array(buffer, offset, plan.rows);
  return Object.freeze({ plan, x, gamma, go, goNormOffset, torch, torchNorm, view });
}
export function validateOperands(fixture) {
  for (const value of fixture.x) if (!Number.isFinite(value) || Math.abs(value) > Math.sqrt(MAX_FLOAT32 / 512)) throw new Error("Normalization input is nonfinite or could overflow Float32 reduction");
  for (const value of fixture.gamma) if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error("Normalization gamma is nonfinite or exceeds32");
}
function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) throw new Error("Invalid normalization request fields");
}
export function validateIdentity(message) {
  if (!message || message.abi !== ABI || typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/u.test(message.id)) throw new Error("Invalid normalization identity");
}
export function validateRequest(message) {
  validateIdentity(message);
  if (message.kind === "probe") { exactKeys(message, ["abi", "id", "kind"]); return null; }
  exactKeys(message, ["abi", "id", "kind", "fixture"]);
  if (message.kind !== "normalize") throw new Error("Unsupported normalization operation");
  const fixture = parseFixture(message.fixture); validateOperands(fixture); return fixture;
}
export function validateDevice(plan, limits) {
  if (!plan) return;
  for (const field of ["maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupStorageSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage", "maxBindingsPerBindGroup", "maxBufferSize", "maxStorageBufferBindingSize"]) {
    if (!Number.isSafeInteger(limits?.[field]) || limits[field] < 1) throw new Error("Missing normalization device limit");
  }
  if (limits.maxComputeInvocationsPerWorkgroup < WIDTH || limits.maxComputeWorkgroupSizeX < WIDTH || limits.maxComputeWorkgroupSizeY < 1 || limits.maxComputeWorkgroupSizeZ < 1
    || limits.maxComputeWorkgroupStorageSize < WIDTH * 4 + 4 || limits.maxComputeWorkgroupsPerDimension < Math.max(plan.x, plan.y)
    || limits.maxStorageBuffersPerShaderStage < 5 || limits.maxBindingsPerBindGroup < 6
    || Math.max(plan.xBytes + 8, plan.resultBytes + 24) > limits.maxBufferSize
    || plan.xBytes + 8 > limits.maxStorageBufferBindingSize) throw new Error("Device does not support normalization fixture");
}
const flush = (value) => value !== 0 && Math.abs(value) < MIN_NORMAL ? Math.sign(value) * 0 : value;
const subnormal = (value) => value !== 0 && Math.abs(value) < MIN_NORMAL;
const normalOrZero = (value) => Number.isFinite(value) && !subnormal(value);
function normRange(sum) {
  // No-underflow positive reduction: one rounded square + eight additions.
  // sqrt inherits 1/inverseSqrt:12u conservatively covers2ULP inverseSqrt
  // and2.5ULP division while both operands/results here are normal.
  const error = GAMMA9 * sum;
  return [Math.max(EPSILON, Math.sqrt(Math.max(0, sum - error)) * (1 - 12 * U)), Math.max(EPSILON, Math.sqrt(sum + error) * (1 + 12 * U))];
}
function divisionRange(value, denominator) {
  const exact = value / denominator, error = 5 * U * Math.abs(exact) + 3 * MIN_SUBNORMAL;
  const options = [exact - error, exact + error];
  if (subnormal(value) || subnormal(exact)) options.push(0);
  return [Math.min(...options), Math.max(...options)];
}
function scaleOptions(quotient, gamma) {
  const options = [];
  for (const ftz of [false, true]) {
    const f = ftz ? (value) => flush(Math.fround(value)) : Math.fround;
    const q = ftz ? flush(quotient) : quotient, g = ftz ? flush(gamma) : gamma;
    options.push(f(f(q * 16) * g), f(f(q * g) * 16), f(q * f(16 * g)));
  }
  return options;
}
export function compareFixture(fixture, result) {
  validateOperands(fixture);
  const { plan, x, gamma, go, torch, torchNorm, view, goNormOffset } = fixture;
  if (!(result instanceof ArrayBuffer) || result.byteLength !== plan.resultBytes) throw new Error("Invalid normalization result geometry");
  const quotient = new Float32Array(result, 0, plan.elements), output = new Float32Array(result, plan.xBytes, plan.elements), denominator = new Float32Array(result, 2 * plan.xBytes, plan.rows);
  const report = { ordinaryElements: 0, underflowLimitedElements: 0, maximumGoDifference: 0, maximumTorchDifference: 0,
    maximumGoBaselineDifference: 0, maximumTorchBaselineDifference: 0, maximumQuotientDifference: 0, maximumDenominatorDifference: 0, maximumTorchDenominatorDifference: 0, negativeZeroDifferences: 0 };
  for (let row = 0; row < plan.rows; row++) {
    let sum = 0, flushedSum = 0, squareUnderflow = false;
    for (let column = 0; column < WIDTH; column++) {
      const value = x[row * WIDTH + column], product = value * value;
      sum += product;
      const fv = flush(value), fp = fv * fv;
      flushedSum += subnormal(fp) ? 0 : fp;
      if (subnormal(value) || subnormal(product)) squareUnderflow = true;
    }
    const norm = Math.sqrt(sum), goD = Math.max(norm, 1e-12), d = denominator[row];
    if (!Number.isFinite(norm) || view.getFloat64(goNormOffset + row * 8, true) !== norm) throw new Error("Saved Go norm disagrees with independent exact-input reduction");
    const regular = normRange(sum), flushed = normRange(flushedSum);
    const lower = squareUnderflow ? Math.min(regular[0], flushed[0]) : regular[0], upper = squareUnderflow ? Math.max(regular[1], flushed[1]) : regular[1];
    if (!Number.isFinite(d) || d < lower || d > upper || !Number.isFinite(torchNorm[row])) throw new Error("Normalization denominator exceeds declared positive-reduction bound");
    report.maximumDenominatorDifference = Math.max(report.maximumDenominatorDifference, Math.abs(d - goD));
    report.maximumTorchDenominatorDifference = Math.max(report.maximumTorchDenominatorDifference, Math.abs(d - Math.max(torchNorm[row], EPSILON)));
    for (let column = 0; column < WIDTH; column++) {
      const index = row * WIDTH + column, value = x[index], g = gamma[column], q = quotient[index], actual = output[index];
      const savedGo = Math.fround(Math.fround(Math.fround(value / goD) * 16) * g);
      if (!Number.isFinite(actual) || !Number.isFinite(q) || !Number.isFinite(torch[index]) || !Object.is(go[index], savedGo)) throw new Error("Saved Go output changed or nonfinite normalization result");
      let qRange = divisionRange(value, d);
      if (subnormal(value)) { const zero = divisionRange(flush(value), d); qRange = [Math.min(qRange[0], zero[0]), Math.max(qRange[1], zero[1])]; }
      if (q < qRange[0] || q > qRange[1]) throw new Error("Normalization quotient exceeds declared division/FTZ diagnostic bound");
      const options = scaleOptions(q, g), scaleError = 2 * U * Math.max(...options.map(Math.abs)) + 2 * MIN_SUBNORMAL;
      if (actual < Math.min(...options) - scaleError || actual > Math.max(...options) + scaleError) throw new Error("Normalization scale exceeds declared association/FTZ diagnostic bound");
      const ideal = (value / goD) * 16 * g;
      const ordinary = !squareUnderflow && normalOrZero(value) && normalOrZero(g) && normalOrZero(q)
        && [q * g, 16 * g, q * 16, q * 16 * g].every(normalOrZero);
      if (ordinary) report.ordinaryElements++; else report.underflowLimitedElements++;
      report.maximumGoDifference = Math.max(report.maximumGoDifference, Math.abs(actual - go[index]));
      report.maximumTorchDifference = Math.max(report.maximumTorchDifference, Math.abs(actual - torch[index]));
      report.maximumGoBaselineDifference = Math.max(report.maximumGoBaselineDifference, Math.abs(go[index] - ideal));
      report.maximumTorchBaselineDifference = Math.max(report.maximumTorchBaselineDifference, Math.abs(torch[index] - ideal));
      report.maximumQuotientDifference = Math.max(report.maximumQuotientDifference, Math.abs(q - value / goD));
      if (actual === 0 && go[index] === 0 && !Object.is(actual, go[index])) report.negativeZeroDifferences++;
    }
  }
  return { ...report, verdict: report.underflowLimitedElements ? "underflow/reassociation-limited diagnostic; not whole-fixture ordinary conformance" : "within declared per-stage ordinary normalization diagnostic bounds",
    bound: "denominator positive-tree gamma9 and12u sqrt; stored quotient5u+3minsub; final all3 associations/FTZ separate; no whole-model tolerance" };
}
