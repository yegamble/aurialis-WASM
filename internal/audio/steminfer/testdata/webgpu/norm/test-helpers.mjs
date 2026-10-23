import { shapePlan, parseFixture } from "./contract.mjs";
function fixture(input = new Float32Array(256), gamma = new Float32Array(256), rows = 1) {
  const plan = shapePlan(rows), buffer = new ArrayBuffer(plan.fixtureBytes), view = new DataView(buffer);
  new Uint8Array(buffer, 0, 8).set(new TextEncoder().encode("AUNORM01")); view.setUint32(8, rows, true); view.setUint32(12, 256, true);
  const result = parseFixture(buffer); result.x.set(input); result.gamma.set(gamma);
  for (let row = 0; row < rows; row++) {
    let sum = 0; for (let column = 0; column < 256; column++) sum += input[row * 256 + column] ** 2;
    const norm = Math.sqrt(sum); view.setFloat64(result.goNormOffset + row * 8, norm, true); result.torchNorm[row] = norm;
    for (let column = 0; column < 256; column++) {
      const i = row * 256 + column;
      result.go[i] = Math.fround(Math.fround(input[i] / Math.max(norm, 1e-12)) * 16) * gamma[column]; result.torch[i] = result.go[i];
    }
  }
  return result;
}
function stages(f) {
  const result = new ArrayBuffer(f.plan.resultBytes), q = new Float32Array(result, 0, f.plan.elements), output = new Float32Array(result, f.plan.xBytes, f.plan.elements), d = new Float32Array(result, 2 * f.plan.xBytes, f.plan.rows);
  for (let row = 0; row < f.plan.rows; row++) {
    const work = f.x.slice(row * 256, (row + 1) * 256); for (let i = 0; i < 256; i++) work[i] *= work[i];
    for (let span = 128; span > 0; span >>= 1) for (let i = 0; i < span; i++) work[i] += work[i + span];
    d[row] = Math.max(Math.sqrt(work[0]), Math.fround(1e-12));
    for (let c = 0; c < 256; c++) { const i = row * 256 + c; q[i] = f.x[i] / d[row]; output[i] = Math.fround(q[i] * 16) * f.gamma[c]; }
  }
  return result;
}

export { fixture, stages };
