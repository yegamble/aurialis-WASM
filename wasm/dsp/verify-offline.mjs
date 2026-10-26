// Run: AURIALIS_OFFLINE_FIXTURE=/tmp/offline.json go test ./wasm/dsp -run TestWriteOfflineJobParityFixture
// Then: node wasm/dsp/verify-offline.mjs module.wasm wasm_exec.js /tmp/offline.json
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash, webcrypto } from "node:crypto";
import assert from "node:assert/strict";

const [wasmPath, runtimePath, fixturePath] = process.argv.slice(2);
assert.ok(wasmPath && runtimePath && fixturePath, "supply module.wasm wasm_exec.js fixture.json");
globalThis.crypto ??= webcrypto;
await import(pathToFileURL(runtimePath).href);
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), go.importObject);
void go.run(instance);
assert.equal(globalThis.aurialisDSPReady, true);
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
assert.ok(fixtures.length > 0, "empty offline fixture");
let maximumMetadataError = 0;
for (const fixture of fixtures) {
  const source = Uint8Array.from(Buffer.from(fixture.source, "base64"));
  const result = globalThis.aurialisOfflineJob(fixture.request, source, new Uint8Array(0), () => {});
  assert.equal(result.ok, true, `${fixture.request}: ${result.error}`);
  const digest = createHash("sha256").update(result.audio).digest("hex");
  assert.equal(digest, fixture.audioSha256, `native/WASM export bytes differ for ${fixture.request}`);
  // Audio bytes are exact; measurements may differ in the last bits of
  // transcendental functions (math.Log10), so they compare to 1e-9.
  let worst = 0;
  const compare = (actual, expected, path) => {
    if (typeof expected === "number") {
      assert.equal(typeof actual, "number", path);
      const error = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
      worst = Math.max(worst, error);
      assert.ok(error <= 1e-9, `${path}: ${actual} vs native ${expected}`);
    } else if (expected !== null && typeof expected === "object") {
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
      for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${path}.${key}`);
    } else {
      assert.equal(actual, expected, path);
    }
  };
  compare(JSON.parse(result.json), JSON.parse(fixture.metadata), "metadata");
  maximumMetadataError = Math.max(maximumMetadataError, worst);
}
console.log(`offline export parity: ${fixtures.length} renders byte-identical; metadata relative error ≤ ${maximumMetadataError.toExponential(1)}`);
