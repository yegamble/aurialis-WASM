/* Test-only actual Wasm wrapper; entrypoints are linker-wrapped C fixtures. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
if (!root) throw new Error("Pass the private build output folder.");
const create = (await import(pathToFileURL(root + "/unit/decoder-cases.mjs"))).default;
const wasmBinary = new Uint8Array(await readFile(root + "/unit/decoder-cases.wasm"));
const wasmMemory = new WebAssembly.Memory({ initial: 1024, maximum: 1024 });
const module = await create({ wasmBinary, wasmMemory, print: () => {}, printErr: () => {} });
const cases = [];
for (let index = 0; index < module._aurialis_test_count(); index++) {
  const result = module._aurialis_test_case(index);
  cases.push({ index, result });
}
const receipt = { tier: "synthetic-wasm-wrapper", compressedParsing: false, audioDecoding: false,
  memoryBytes: wasmMemory.buffer.byteLength, cases };
await writeFile(root + "/unit/cases-result.json", JSON.stringify(receipt, null, 2) + "\n");
assert.equal(cases.length, 22);
assert.equal(wasmMemory.buffer.byteLength, 64 * 1024 * 1024);
assert.deepEqual(cases.filter((item) => item.result !== 0), []);
console.log("22/22 synthetic Wasm C wrapper cases passed; no compressed parser or codec executed.");
