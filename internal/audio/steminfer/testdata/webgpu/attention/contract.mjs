/** Private CPU admission/numeric design. No GPU calls or app import. */
export const ABI = "aurialis-private-attention-stages-1";
export const DIMENSION = 64;
export const MIN_NORMAL = 2 ** -126;
export const MIN_SUBNORMAL = 2 ** -149;
export const MAX_APPLICATION_BYTES = 16 * 1024 * 1024;
export const MAX_REFERENCE_WORK = 2_097_152;
export const MAX_GPU_WORK = 8_388_608;
const DIRECTED_U = 2 ** -23;
const words = new DataView(new ArrayBuffer(8));
const finite = (x) => { if (!Number.isFinite(x)) throw new Error("Nonfinite attention arithmetic"); return x; };
export const subnormal = (x) => x !== 0 && Math.abs(x) < MIN_NORMAL;
function adjacent64(x, up) {
  finite(x);
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  words.setFloat64(0, x, false);
  let bits = words.getBigUint64(0, false);
  bits += (x > 0) === up ? 1n : -1n;
  words.setBigUint64(0, bits, false);
  return words.getFloat64(0, false);
}
const down = (x) => adjacent64(x, false), up = (x) => adjacent64(x, true);
export function shapePlan(m, n, dimension = DIMENSION) {
  if (!Number.isSafeInteger(m) || !Number.isSafeInteger(n) || m < 1 || m > 8 || n < 1 || n > 1723 || dimension !== DIMENSION) throw new Error("Unsupported closed attention shape");
  const cells = m * n, output = m * DIMENSION, inputs = output + 2 * n * DIMENSION;
  const stageCells = 5 * cells + 2 * m + output;
  const fixtureCells = inputs + 9 * cells + 4 * output + 2 * m;
  const fixtureBytes = 24 + 4 * fixtureCells, inputBytes = 4 * inputs, stageBytes = 4 * stageCells;
  // Coarse reference units: both dot-product term visits, twelve scalar stage
  // visits per score and2048 bounded row-level visits. This is NOT an instruction
  // count: compensated sums, fixed18-term exp intervals, scans and copying cost
  // more machine operations. Payload scan count is separately disclosed below.
  const referenceWork = 2 * m * n * DIMENSION + 12 * cells + 2048 * m;
  const paddedKeys64 = Math.ceil(n / 64) * 64, paddedKeys256 = Math.ceil(n / 256) * 256;
  // GPU units count floating data arithmetic/reduction comparisons, with a dot term
  // charged twice (multiply+add), and all padded invocations conservatively. Integer indexing/control is
  // separately bounded by allocationPlan, not included in this FP budget.
  const gpuStages = Object.freeze({
    raw: 2 * m * paddedKeys64 * DIMENSION,
    scaled: m * paddedKeys64,
    maximum: m * (paddedKeys256 + 255),
    shifted: m * paddedKeys64,
    exponential: m * paddedKeys64,
    denominator: m * (paddedKeys256 + 255),
    probability: m * paddedKeys64,
    output: 2 * m * DIMENSION * n,
  });
  const gpuWork = Object.values(gpuStages).reduce((a, b) => a + b, 0);
  // Prospective buffer envelope; implementation/ownership/canary evidence is
  // still required before any GPU run. Five full-file copies cover caller,
  // private snapshot, worker transfer and checksum staging; four input copies
  // cover upload/init/GPU staging; ten stage copies cover GPU+readback+mapped
  // result+transfer+CPU interval scratch. Fixed allowance includes capture.
  const chargedApplicationBytes = 5 * fixtureBytes + 4 * inputBytes + 10 * stageBytes + 65536 + 512 * 1024;
  for (const x of [cells, output, inputs, stageCells, fixtureCells, fixtureBytes, referenceWork, gpuWork, chargedApplicationBytes]) if (!Number.isSafeInteger(x) || x < 1 || x > 0xffff_ffff) throw new Error("Attention derived index overflow");
  if (referenceWork > MAX_REFERENCE_WORK || gpuWork > MAX_GPU_WORK || chargedApplicationBytes > MAX_APPLICATION_BYTES) throw new Error("Attention resource cap exceeded");
  return Object.freeze({ m, n, dimension, cells, output, inputs, stageCells, fixtureCells, fixtureBytes, inputBytes, stageBytes, referenceWork, gpuWork, gpuStages, chargedApplicationBytes,
    payloadScanFloatCount: fixtureCells, maximumExpSeriesTerms: 18, maximumExpSquarings: 15, workgroupStorageBytes: 1024, qkGroups: Math.ceil(n / 64) * m, pvGroups: m });
}
export function parseFixture(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > MAX_APPLICATION_BYTES) throw new Error("Invalid attention fixture bytes");
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== "AURATT01" || view.getUint32(20, true) !== 0) throw new Error("Invalid attention fixture header");
  const plan = shapePlan(view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true));
  if (buffer.byteLength !== plan.fixtureBytes) throw new Error("Attention fixture geometry changed");
  const layout = [["q", plan.output], ["k", plan.n * 64], ["v", plan.n * 64],
    ["goRaw", plan.cells], ["goProbability", plan.cells], ["goOutput", plan.output],
    ["torchRaw", plan.cells], ["torchProbability", plan.cells], ["torchOutput", plan.output], ["sdpaOutput", plan.output],
    ["raw", plan.cells], ["scaled", plan.cells], ["maximum", plan.m], ["shifted", plan.cells], ["exponential", plan.cells], ["denominator", plan.m], ["probability", plan.cells], ["output", plan.output]];
  let offset = 24;
  const arrays = {};
  for (const [name, count] of layout) { arrays[name] = new Float32Array(buffer, offset, count); offset += count * 4; }
  if (offset !== buffer.byteLength) throw new Error("Attention layout invariant");
  return Object.freeze({ plan, arrays, view });
}
export function validateFixture(fixture) {
  for (const [name, values] of Object.entries(fixture.arrays)) for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("Nonfinite attention operand/reference");
    if ((name === "q" || name === "k") && Math.abs(value) > 16 || name === "v" && Math.abs(value) > 32) throw new Error("Attention operand magnitude cap exceeded");
  }
}
export function directedFloat32Interval(value) {
  finite(value);
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new Error("Float32 overflow before dispatch");
  if (rounded === value) return [value, value];
  words.setFloat32(0, rounded, false);
  let bits = words.getUint32(0, false);
  const towardUp = rounded < value;
  if (rounded === 0) return value > 0 ? [0, MIN_SUBNORMAL] : [-MIN_SUBNORMAL, 0];
  bits += (rounded > 0) === towardUp ? 1 : -1;
  words.setUint32(0, bits, false);
  const other = words.getFloat32(0, false);
  return [Math.min(rounded, other), Math.max(rounded, other)];
}
export function ulp32Upper(value) {
  finite(value);
  if (Math.abs(value) < MIN_NORMAL) return MIN_SUBNORMAL;
  // At exact powers of two this deliberately uses the larger adjacent spacing.
  words.setFloat32(0, Math.abs(value), false);
  const exponent = (words.getUint32(0, false) >>> 23) & 255;
  if (exponent === 255) throw new Error("Float32 ULP overflow");
  return 2 ** (exponent - 127 - 23);
}
export function dyadicQuantum(value) {
  if (value === 0) return Infinity;
  words.setFloat32(0, Math.abs(value), false);
  const bits = words.getUint32(0, false), exponent = (bits >>> 23) & 255;
  let significand = (bits & 0x7fffff) | (exponent ? 0x800000 : 0), trailing = 0;
  while ((significand & 1) === 0) { significand >>>= 1; trailing++; }
  return (exponent ? exponent - 127 - 23 : -149) + trailing;
}
export function dotDiagnostic(left, right, count, leftOffset = 0, rightOffset = 0, rightStride = 1, visit) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1723 || leftOffset < 0 || rightOffset < 0 || !Number.isSafeInteger(rightStride) || rightStride < 1
    || leftOffset + count > left.length || rightOffset + (count - 1) * rightStride >= right.length) throw new Error("Unsafe compensated dot geometry");
  let sum = 0, correction = 0, absolute = 0, absoluteCorrection = 0, limited = false, quantum = Infinity;
  for (let i = 0; i < count; i++) {
    const a = finite(left[leftOffset + i]), b = finite(right[rightOffset + i * rightStride]), product = finite(a * b);
    if (visit) visit(a, b, product, i);
    let next = sum + product;
    correction += Math.abs(sum) >= Math.abs(product) ? (sum - next) + product : (product - next) + sum;
    sum = next;
    const magnitude = Math.abs(product); next = absolute + magnitude;
    absoluteCorrection += (absolute - next) + magnitude; absolute = next;
    limited ||= subnormal(a) || subnormal(b) || subnormal(product);
    if (product !== 0) quantum = Math.min(quantum, dyadicQuantum(a) + dyadicQuantum(b));
  }
  const value = finite(sum + correction), absoluteValue = absolute + absoluteCorrection, sumAbsolute = absoluteValue === 0 ? 0 : up(absoluteValue);
  // A normal exact dyadic grid makes every sum-of-products partial sum either
  // zero or normal, independently of summation order. A finer grid stays limited.
  limited ||= quantum < -126;
  // Conservative diagnostic enclosure, not an exact-real oracle: binary32
  // products fit binary64 exactly, then at most4K rounded binary64 operations.
  const doubleU = 2 ** -52, gamma64 = 4 * count * doubleU / (1 - 4 * count * doubleU);
  const referenceError = sumAbsolute === 0 ? 0 : up(gamma64 * sumAbsolute + count * Number.MIN_VALUE);
  const gamma32 = 2 * count * DIRECTED_U / (1 - 2 * count * DIRECTED_U);
  const arithmeticError = sumAbsolute === 0 ? 0 : up(gamma32 * sumAbsolute + referenceError);
  return Object.freeze({ value, sumAbsolute, referenceError, arithmeticError,
    // This additional absolute floor is only an FTZ diagnostic envelope. Such
    // a row cannot earn ordinary whole-fixture qualification from this floor.
    ftzError: sumAbsolute === 0 ? 0 : up(arithmeticError + 35 * count * MIN_NORMAL), underflowLimited: limited });
}
export function expReferenceInterval(argument) {
  if (!Number.isFinite(argument) || argument > 0 || argument < -4096) throw new Error("Stable attention exp argument outside admitted range");
  if (argument === 0) return [1, 1];
  let squarings = 0, a = -argument;
  while (a > .125) { a /= 2; squarings++; }
  let lower = 1, upper = 1, lowTerm = 1, highTerm = 1;
  for (let i = 1; i <= 18; i++) {
    lowTerm = Math.max(0, down(down(lowTerm * a) / i)); highTerm = up(up(highTerm * a) / i);
    lower = Math.max(0, down(lower + lowTerm)); upper = up(upper + highTerm);
  }
  // Positive series remainder uses a geometric majorant, a<=1/8.
  const ratio = up(a / 19), remainder = up(up(highTerm * ratio) / down(1 - up(a / 20)));
  upper = up(upper + remainder);
  let low = Math.max(0, down(1 / upper)), high = up(1 / lower);
  for (let i = 0; i < squarings; i++) { low = Math.max(0, down(low * low)); high = up(high * high); }
  return [low, high];
}
export function expGPUInterval(argument) {
  const reference = expReferenceInterval(argument), ulps = 3 + 2 * Math.abs(argument);
  const error = up(ulps * Math.max(ulp32Upper(reference[0]), ulp32Upper(reference[1])));
  const lower = Math.max(0, down(reference[0] - error)), upper = up(reference[1] + error);
  const underflowLimited = reference[1] > 0 && reference[0] < MIN_NORMAL || subnormal(argument);
  return Object.freeze({ lower: underflowLimited ? 0 : lower, upper, reference, underflowLimited });
}
export function divisionGPUInterval(numerator, denominator) {
  if (!Number.isFinite(numerator) || numerator < 0 || !Number.isFinite(denominator) || denominator < MIN_NORMAL || denominator > 2 ** 126) throw new Error("Attention division outside declared WGSL range");
  const exactDiagnostic = numerator / denominator, diagnosticError = Math.abs(up(exactDiagnostic) - down(exactDiagnostic));
  const error = up(2.5 * ulp32Upper(exactDiagnostic) + diagnosticError);
  const underflowLimited = subnormal(numerator) || exactDiagnostic !== 0 && exactDiagnostic < MIN_NORMAL;
  return Object.freeze({ lower: underflowLimited ? 0 : Math.max(0, down(exactDiagnostic - error)), upper: up(exactDiagnostic + error), underflowLimited });
}
function intervalContains(value, interval, label) {
  if (!Number.isFinite(value) || value < interval[0] || value > interval[1]) throw new Error("Attention " + label + " exceeds independent stage enclosure");
}
function subtractionInterval(left, right) {
  if (left === right) return [0,0];
  // Enclose the binary64 subtraction itself before Float32 directed rounding.
  const difference=left-right, lower=directedFloat32Interval(down(difference))[0], upper=directedFloat32Interval(up(difference))[1];
  const options=[lower,upper];
  if(subnormal(left)||subnormal(right)) {
    const a=subnormal(left)?0:left,b=subnormal(right)?0:right;
    options.push(...directedFloat32Interval(a-b));
  }
  if(options.some(subnormal)) options.push(0);
  return [Math.min(...options),Math.max(...options)];
}
export function classifyStages(fixture) {
  validateFixture(fixture);
  const a = fixture.arrays, reasons = new Set();
  for (const name of ["q", "k", "v"]) if (a[name].some(subnormal)) reasons.add("source-underflow");
  for (let row = 0; row < fixture.plan.m; row++) {
    let smallestMaximum=-Infinity,largestMaximum=-Infinity;
    for (let column = 0; column < fixture.plan.n; column++) {
      const index = row * fixture.plan.n + column;
      const dot = dotDiagnostic(a.q, a.k, 64, row * 64, column * 64);
      for (const name of ["goRaw", "torchRaw", "raw"]) if (Math.abs(a[name][index] - dot.value) > (dot.underflowLimited ? dot.ftzError : dot.arithmeticError)) throw new Error("Saved raw attention reference fails independent dot enclosure");
      if(dot.underflowLimited) reasons.add("dot-or-score-underflow");
      const scaled=directedFloat32Interval(a.raw[index]*.125);
      if(subnormal(a.raw[index])||scaled.some(subnormal)) { scaled[0]=Math.min(0,scaled[0]);scaled[1]=Math.max(0,scaled[1]);reasons.add("dot-or-score-underflow"); }
      intervalContains(a.scaled[index],scaled,"scale");
      smallestMaximum=Math.max(smallestMaximum,subnormal(a.scaled[index])?Math.min(0,a.scaled[index]):a.scaled[index]);
      largestMaximum=Math.max(largestMaximum,subnormal(a.scaled[index])?Math.max(0,a.scaled[index]):a.scaled[index]);
    }
    intervalContains(a.maximum[row],[smallestMaximum,largestMaximum],"maximum");
    let expSum=0,expCorrection=0;
    for(let column=0;column<fixture.plan.n;column++) {
      const index=row*fixture.plan.n+column, shifted=subtractionInterval(a.scaled[index],a.maximum[row]);
      intervalContains(a.shifted[index],shifted,"shift");
      if(subnormal(a.scaled[index])||subnormal(a.shifted[index])||shifted.some(subnormal)) reasons.add("dot-or-score-underflow");
      const exponential=expGPUInterval(a.shifted[index]);
      intervalContains(a.exponential[index],[exponential.lower,exponential.upper],"exponential");
      if(exponential.underflowLimited) reasons.add("exponential-underflow");
      const term=a.exponential[index],next=expSum+term;
      expCorrection+=(expSum-next)+term;expSum=next;
    }
    const sum=expSum+expCorrection, count=fixture.plan.n;
    const doubleGamma=4*count*2**-52/(1-4*count*2**-52), gamma=2*count*DIRECTED_U/(1-2*count*DIRECTED_U);
    const error=up((gamma+doubleGamma)*sum+count*MIN_NORMAL);
    intervalContains(a.denominator[row],[Math.max(MIN_NORMAL,down(sum-error)),up(sum+error)],"denominator");
    for(let column=0;column<fixture.plan.n;column++) {
      const index=row*fixture.plan.n+column, probability=divisionGPUInterval(a.exponential[index],a.denominator[row]);
      intervalContains(a.probability[index],[probability.lower,probability.upper],"probability");
      if(probability.underflowLimited) reasons.add("probability-underflow");
    }
    for(let column=0;column<64;column++) {
      const dot=dotDiagnostic(a.probability,a.v,fixture.plan.n,row*fixture.plan.n,column,64);
      intervalContains(a.output[row*64+column],[down(dot.value-(dot.underflowLimited?dot.ftzError:dot.arithmeticError)),up(dot.value+(dot.underflowLimited?dot.ftzError:dot.arithmeticError))],"PV");
      if(dot.underflowLimited) reasons.add("PV-underflow-grid");
    }
  }
  return Object.freeze({ classification: reasons.size ? "underflow-limited" : "ordinary-input-diagnostic", reasons: [...reasons],
    qualification: "CPU local-stage audit only; propagated end-to-end intervals, worker ownership and hardware gates pending", gpuDispatched: false });
}
