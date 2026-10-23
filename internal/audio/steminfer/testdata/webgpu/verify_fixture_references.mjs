/** Cross-check independent Go references before any GPU use; this is not a GPU test. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { parseFixture, compareFixture } from "./contract.mjs";
const directory = process.argv[2];
if (!directory) throw new Error("Provide the private Go fixture directory");
const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
assert.equal(manifest.format, "aurialis-private-gemm-fixtures-1");
assert.equal(manifest.cases.length, 70);
const seen = new Set();
let maximumAbsoluteError = 0, maximumF32Difference = 0;
const categories = new Map();
for (const item of manifest.cases) {
  assert.match(item.name, /^[a-z0-9-]{1,96}\.bin$/u);assert.ok(!seen.has(item.name));seen.add(item.name);
  const file = path.join(directory, item.name), stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());assert.equal(stat.size, item.bytes);assert.ok(stat.size < 16 * 1024 * 1024);
  const bytes = await readFile(file);assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  const fixture = parseFixture(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.deepEqual([fixture.plan.m, fixture.plan.n, fixture.plan.k], [item.m, item.n, item.k]);
  const output = new Float32Array(fixture.plan.cElements);
  for (let i = 0; i < output.length; i++) output[i] = fixture.view.getFloat32(fixture.f32Offset + i * 4, true);
  const report = compareFixture(fixture, output);
  assert.equal(report.normalViolations, 0);
  maximumAbsoluteError = Math.max(maximumAbsoluteError, report.maximumAbsoluteError);
  maximumF32Difference = Math.max(maximumF32Difference, report.maximumF32Difference);
  const category = categories.get(item.kind) ?? { cases: 0, maximumAbsoluteError: 0, maximumErrorPerSumAbsoluteProducts: 0 };
  category.cases++;category.maximumAbsoluteError = Math.max(category.maximumAbsoluteError, report.maximumAbsoluteError);
  for (let i = 0; i < output.length; i++) {
    const error = Math.abs(output[i] - fixture.view.getFloat64(fixture.expectedOffset + i * 8, true));
    const sumabs = fixture.view.getFloat64(fixture.sumOffset + i * 8, true);
    category.maximumErrorPerSumAbsoluteProducts = Math.max(category.maximumErrorPerSumAbsoluteProducts, sumabs ? error / sumabs : 0);
  }
  categories.set(item.kind, category);
}
console.log(JSON.stringify({ scope: "Go versus independent JS reference consistency only; no GPU", cases: seen.size, maximumAbsoluteError, maximumF32Difference, gpuDispatched: false, categories: Object.fromEntries(categories) }, null, 2));
