import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const legacyNames = ["aurialisDSPInit", "aurialisDSPReset", "aurialisDSPSetParams", "aurialisDSPSetBand", "aurialisDSPProcessBlock", "aurialisDSPMeasure"];
const [mode, wasmPath, runtimePath] = process.argv.slice(2);
if (mode === "--probe-prod" || mode === "--probe-tagged") {
  globalThis.crypto ??= webcrypto;
  await import(pathToFileURL(runtimePath).href);
  const go = new globalThis.Go();
  const bytes = await readFile(wasmPath);
  const module = await WebAssembly.compile(bytes);
  const exports = WebAssembly.Module.exports(module).map(({ name }) => name);
  const instance = await WebAssembly.instantiate(module, go.importObject);
  const initialPages = instance.exports.mem.buffer.byteLength / 65536;
  void go.run(instance);
  for (let attempt = 0; attempt < 100 && globalThis.aurialisOfflineReady !== true; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(globalThis.aurialisOfflineReady, true, "offline job must be registered");
  const legacyCount = legacyNames.filter(name => typeof globalThis[name] === "function").length;
  const legacyPresent = legacyCount === legacyNames.length;
  const aurialisGlobals = Object.keys(globalThis).filter(name => name.startsWith("aurialis")).sort();
  if (mode === "--probe-prod") {
    assert.equal(legacyCount, 0, "production module must omit every legacy JS global");
    assert.deepEqual(aurialisGlobals, ["aurialisOfflineAbi", "aurialisOfflineJob", "aurialisOfflineReady"]);
    for (const name of ["aurialis_live_process", "aurialis_schedule_begin", "aurialis_control_count"]) {
      assert.equal(exports.includes(name), false, `production export ${name}`);
    }
  } else {
    assert.equal(legacyCount, legacyNames.length, "tagged QA module must retain every legacy JS global");
    assert.deepEqual(aurialisGlobals, [...legacyNames, "aurialisDSPReady", "aurialisOfflineAbi", "aurialisOfflineJob", "aurialisOfflineReady"].sort());
    for (const name of ["aurialis_live_process", "aurialis_schedule_begin", "aurialis_control_count"]) {
      assert.equal(exports.includes(name), true, `tagged legacy export ${name}`);
    }
  }
  console.log(JSON.stringify({ bytes: bytes.byteLength, initialPages, offlineJob: true, legacyBridge: legacyPresent, exports: exports.filter(name => name.startsWith("aurialis_")) }));
  process.exit(0);
}

const [productionPath, legacyPath, wasmExecPath] = process.argv.slice(2);
assert.ok(productionPath && legacyPath && wasmExecPath, "supply production.wasm tagged-legacy.wasm wasm_exec.js");
const invoke = (kind, modulePath) => {
  const result = spawnSync(process.execPath, [process.argv[1], kind, modulePath, wasmExecPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
};
const production = invoke("--probe-prod", productionPath);
const tagged = invoke("--probe-tagged", legacyPath);
assert.ok(tagged.bytes > production.bytes, "tagged probe should be larger than production module");
console.log(`JS-WASM artifact isolation: production ${production.bytes} bytes/${production.initialPages} initial pages; tagged QA probe ${tagged.bytes} bytes/${tagged.initialPages} initial pages; production legacy globals absent; offline job present in both`);
