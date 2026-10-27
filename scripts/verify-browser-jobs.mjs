import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { webcrypto } from "node:crypto";

const root = process.cwd();
const directory = path.join(root, "artifacts/browser-local/wasm-oracle");
await mkdir(directory, { recursive: true });
globalThis.crypto ??= webcrypto;
// Qualify the distributed Go runtime/module pair restored from the artifact.
await import(pathToFileURL(path.join(root, "public/wasm/wasm_exec.js")).href);
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(await readFile("public/wasm/aurialis-dsp.wasm"), go.importObject);
void go.run(instance);
assert.equal(typeof globalThis.aurialisOfflineJob, "function");
assert.equal(globalThis.aurialisOfflineAbi, "1.0");
const rate = 8000, frames = 2049, source = Buffer.alloc(44 + frames * 8);
source.write("RIFF"); source.writeUInt32LE(source.length - 8, 4); source.write("WAVEfmt ", 8); source.writeUInt32LE(16, 16); source.writeUInt16LE(3, 20); source.writeUInt16LE(2, 22); source.writeUInt32LE(rate, 24); source.writeUInt32LE(rate * 8, 28); source.writeUInt16LE(8, 32); source.writeUInt16LE(32, 34); source.write("data", 36); source.writeUInt32LE(frames * 8, 40);
for (let i = 0; i < frames; i++) { source.writeFloatLE(.1 * Math.sin(i * .13) + .03 * Math.sin(i * .43), 44 + i * 8); source.writeFloatLE(.08 * Math.cos(i * .17), 48 + i * 8); }
source.writeFloatLE(1.25, 44); source.writeFloatLE(-0, 48);
let count = 0;
let maximumDiagnosticError = 0;
const metric = "(?:integratedLufs|shortTermLufs|truePeakDbtp|samplePeakDbfs|dynamicRangeDb|correlation|lowBassCorrelation|dcLeftDbfs|dcRightDbfs|gainReductionDb)";
// Only declared diagnostic/scoring fields admit evidenced libm roundoff.
// Parameters, source identity, integer geometry and compiled packets stay exact.
const diagnosticPaths = [
  new RegExp(`^(?:beforeMetrics|afterMetrics)\\.${metric}$`, "u"),
  new RegExp(`^scriptV2\\.beforeMetrics\\.${metric}$`, "u"),
  // Deep prediction measurements; the Level match gain and thresholds are rounded parameters and stay exact.
  new RegExp(`^prediction\\.afterMetrics\\.${metric}$`, "u"),
  /^prediction\.(?:compressorAverageGainReductionDb|limiterPeakGainReductionDb|levelMatch\.neededDb)$/u,
  /^features\.bands\[\d+\]\.(?:powerDb|densityDbPerHz)$/u,
  /^features\.frames\[\d+\]\.(?:rmsDb|centroidHz|sideMidDb|crestDb)$/u,
  /^features\.sibilanceRatioDb$/u,
  /^features\.windowCrestPercentiles\[\d+\]$/u,
  /^(?:features|scriptV2)\.sections\[\d+\]\.confidence$/u,
  /^referenceProposal\.bands\[\d+\]\.(?:sourceDensityDb|referenceDensityDb|targetDeltaDb|predictedDeltaDb)$/u,
  /^referenceProposal\.(?:beforeResidualDb|fitResidualDb|beforeOutputResidualDb|afterOutputResidualDb|maxPredictedBoostDb|maxProtectedDeltaDb|remeasuredProtectedDeltaDb)$/u,
  /^referenceProposal\.width\.(?:sourceSideMidDb|referenceSideMidDb|beforeSideMidDb|afterSideMidDb|beforeCorrelation|afterCorrelation|afterSamplePeakDbfs)$/u,
];
function compareMetadata(actual, expected, field = "") {
  assert.equal(typeof actual, typeof expected, `type changed at ${field}`);
  if (typeof actual === "number") {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `nonfinite diagnostic at ${field}`);
    if (actual === expected) return;
    const error = Math.abs(actual - expected);
    if (diagnosticPaths.some((pattern) => pattern.test(field))) {
      maximumDiagnosticError = Math.max(maximumDiagnosticError, error);
      assert.ok(error <= 1e-10, `diagnostic error ${error} exceeds1e-10 at ${field}`);
    } else assert.equal(actual, expected, `exact numeric contract changed at ${field}`);
    return;
  }
  if (Array.isArray(actual)) {
    assert.ok(Array.isArray(expected), `array shape changed at ${field}`);
    assert.equal(actual.length, expected.length, `array length changed at ${field}`);
    actual.forEach((value, index) => compareMetadata(value, expected[index], `${field}[${index}]`));
    return;
  }
  if (actual !== null && typeof actual === "object") {
    assert.ok(expected !== null && typeof expected === "object", `object shape changed at ${field}`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `object keys changed at ${field}`);
    for (const key of Object.keys(actual)) compareMetadata(actual[key], expected[key], field ? `${field}.${key}` : key);
    return;
  }
  assert.equal(actual, expected, `exact contract changed at ${field}`);
}
async function check(name, request, input = source, reference = Buffer.alloc(0)) {
  await writeFile(path.join(directory, "request.json"), JSON.stringify(request));
  await writeFile(path.join(directory, "source.wav"), input);
  if (reference.length) await writeFile(path.join(directory, "reference.wav"), reference);
  else await rm(path.join(directory, "reference.wav"), { force: true });
  const native = spawnSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { cwd: root, env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, encoding: "utf8" });
  assert.equal(native.status, 0, `${name}: native oracle failed: ${native.stdout}${native.stderr}`);
  const actual = globalThis.aurialisOfflineJob(JSON.stringify(request), new Uint8Array(input), new Uint8Array(reference), () => {});
  assert.equal(actual.ok, true, `${name}: ${actual.error}`);
  const expectedAudio = await readFile(path.join(directory, "native.wav"));
  assert.equal(Buffer.compare(Buffer.from(actual.audio), expectedAudio), 0, `${name}: native/WASM audio bytes differ`);
  const expected = JSON.parse(await readFile(path.join(directory, "native.json"), "utf8"));
  compareMetadata(JSON.parse(actual.json), expected);
  count++;
  return JSON.parse(actual.json);
}
await check("canonical float import", { operation: "render", params: '{"bypass":true}', bitDepth: 32 });
for (const bitDepth of [16, 24, 32]) await check(`static export ${bitDepth}`, { operation: "render", params: '{"inputGainDb":-3,"compressor":{"enabled":false},"saturation":{"enabled":false},"limiter":{"truePeak":false}}', bitDepth });
await check("source features", { operation: "features" });
const deep = await check("measured Deep", { operation: "deep", profile: "modern_pop_polish", scriptVersion: "2.0" });
await check("source-bound script render", { operation: "render", script: JSON.stringify(deep.scriptV2), bitDepth: 32 });
await check("numeric compiler", { operation: "compile", script: JSON.stringify(deep.scriptV2), deviceRate: 48000 }, Buffer.alloc(0));
await check("measured Reference", { operation: "reference", options: '{"amount":0.5,"protectBelowHz":120}' }, source, source);
for (const hostile of [Buffer.from("MZ executable payload"), source.subarray(0, source.length - 1), Buffer.concat([source, Buffer.from("%PDF- hidden payload")])]) {
  assert.equal(globalThis.aurialisOfflineJob('{"operation":"render"}', new Uint8Array(hostile), new Uint8Array(0), () => {}).ok, false, "hostile audio survived actual WASM CDR");
  count++;
}
assert.equal(globalThis.aurialisOfflineJob('{"operation":"features","operation":"render"}', new Uint8Array(source), new Uint8Array(0), () => {}).ok, false);
count++;
console.log(`Actual browser-job Go WASM matched native exact audio/controls/geometry for ${count} bounded checks, including hostile CDR; maximum whitelisted floating diagnostic error=${maximumDiagnosticError} (limit1e-10).`);
