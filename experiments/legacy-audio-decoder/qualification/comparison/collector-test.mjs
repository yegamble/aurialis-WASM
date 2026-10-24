import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { comparePcm } from "./compare-pcm.mjs";
const source = await readFile(new URL("./decode-page.mjs", import.meta.url), "utf8");
const workerPath = "/decoder.worker." + "a".repeat(64) + ".mjs";
function fixture() {
  const workers = [];
  class Worker {
    constructor() { this.terminated = 0; this.messages = []; workers.push(this); }
    postMessage(value) { this.messages.push(value); }
    terminate() { this.terminated++; }
    emit(data) { this.onmessage({ data }); }
  }
  const context = vm.createContext({ Worker, File, Uint8Array, ArrayBuffer, DataView, Number, String, Error, crossOriginIsolated: true, setTimeout: () => 1, clearTimeout: () => {}, document: { getElementById: () => ({ files: [new File([new Uint8Array(20)], "generated.bin")] }) } });
  vm.runInContext(source, context);
  return { context, workers };
}
const chunk = (id) => ({ kind: "chunk", abi: 1, id, sequence: 1, frames: 1, rate: 48000, channels: 1, audio: new Float32Array([0.5, 0.5]).buffer });
test("cancel drops the prefix and queued old end cannot affect a new owned Worker", () => {
  const { context, workers } = fixture();
  context.decodeSelected(workerPath, "old"); const old = workers[0];
  old.emit(chunk("old")); context.cancelOwnedDecode();
  assert.equal(context.result.status, "red"); assert.equal(context.result.framesBeforeFailure, 1); assert.equal(old.terminated, 1);
  assert.equal("audioBase64" in context.result, false);
  context.decodeSelected(workerPath, "new"); const current = workers[1];
  old.emit({ kind: "end", abi: 1, id: "old", sequence: 1, frames: 1, rate: 48000, channels: 1 });
  assert.equal(context.result.status, "pending"); assert.equal(context.result.id, "new"); assert.equal(current.terminated, 0);
  current.emit(chunk("new")); current.emit({ kind: "end", abi: 1, id: "new", sequence: 1, frames: 1, rate: 48000, channels: 1 });
  assert.equal(context.result.status, "decoded-unqualified"); assert.equal(context.result.frames, 1); assert.equal(current.terminated, 1);
});
test("actual protocol error after prefix never returns PCM", () => {
  const { context, workers } = fixture(); context.decodeSelected(workerPath, "error-case");
  workers[0].emit(chunk("error-case")); workers[0].emit({ kind: "error", abi: 1, id: "error-case", error: "synthetic sticky prefix failure" });
  assert.equal(context.result.status, "red"); assert.equal(context.result.framesBeforeFailure, 1); assert.equal(context.result.cdrCalled, false); assert.equal("audioBase64" in context.result, false);
});
test("later chunk geometry change fails without a successful end", () => {
  const { context, workers } = fixture(); context.decodeSelected(workerPath, "geometry"); workers[0].emit(chunk("geometry"));
  workers[0].emit({ ...chunk("geometry"), sequence: 2, rate: 44100 });
  assert.equal(context.result.status, "red"); assert.equal("audioBase64" in context.result, false);
});
const criteria = { lossyMaximumAbsoluteError: 2e-5, lossyMaximumRmsError: 2e-6 };
const floats = (values) => Buffer.from(new Float32Array(values).buffer);
test("mono duplicate bits are required even when channel error fits numeric tolerance", () => {
  assert.throws(() => comparePcm(floats([0, -0]), floats([0]), { frames: 1, channels: 1 }, criteria, false), /Mono duplication/);
});
test("lossless differences and count mismatches remain RED, no alignment", () => {
  assert.equal(comparePcm(floats([0, 0, 0.5, 0.5]), floats([0, 0.5]), { frames: 2, channels: 1 }, criteria, true).pass, true);
  assert.equal(comparePcm(floats([0, 0, 0.500001, 0.500001]), floats([0, 0.5]), { frames: 2, channels: 1 }, criteria, true).pass, false);
  assert.throws(() => comparePcm(floats([0, 0]), floats([0, 0.5]), { frames: 2, channels: 1 }, criteria, false));
});
test("fixed lossy limits use both maximum and RMS, preserving finite headroom", () => {
  const result = comparePcm(floats([1.25, 1.25]), floats([1.25]), { frames: 1, channels: 1 }, criteria, false);
  assert.equal(result.pass, true); assert.equal(result.wasmMarkers[0].aboveUnity, 1);
  assert.equal(comparePcm(floats([1e-5, 1e-5]), floats([0]), { frames: 1, channels: 1 }, criteria, false).pass, false);
});
