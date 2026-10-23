import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
const root = process.argv[2];
if (!root) throw new Error("Pass private build output.");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(await readFile(root + "/assets/assets.json", "utf8"));
assert.equal(manifest.status, "private-unqualified"); assert.equal(manifest.distributionApproved, false);
let total = 0;
for (const item of manifest.assets) {
  assert.match(item.path, /^[a-zA-Z0-9.-]+$/);
  const bytes = await readFile(root + "/assets/" + item.path);
  assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256); total += bytes.length;
}
assert.equal(total, manifest.assetBytes); assert.ok(total <= 32 * 1024 * 1024);
const wasmItem = manifest.assets.find((item) => /^decoder-core\.[a-f0-9]{64}\.wasm$/.test(item.path));
assert.ok(wasmItem); assert.ok(wasmItem.bytes <= 16 * 1024 * 1024);
const bytes = new Uint8Array(await readFile(root + "/assets/" + wasmItem.path));
const module = new WebAssembly.Module(bytes); // Compile for inspection; never instantiate runtime core.
let at = 8;
function uint() { let value = 0, shift = 0, part; do { part = bytes[at++]; assert.ok(shift < 35); value += (part & 127) * 2 ** shift; shift += 7; } while (part & 128); return value; }
function string() { const length = uint(), end = at + length; assert.ok(end <= bytes.length); const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, end)); at = end; return value; }
function limits() { const flags = uint(), initial = uint(), maximum = flags & 1 ? uint() : null; return { flags, initial, maximum }; }
const memoryImports = []; let definedMemories = 0;
while (at < bytes.length) {
  const section = bytes[at++], length = uint(), end = at + length;
  assert.ok(end <= bytes.length);
  if (section === 2) {
    const count = uint();
    for (let index = 0; index < count; index++) {
      const namespace = string(), field = string(), kind = bytes[at++];
      if (kind === 0) uint();
      else if (kind === 1) { at++; limits(); }
      else if (kind === 2) memoryImports.push({ namespace, field, ...limits() });
      else if (kind === 3) at += 2;
      else throw new Error("Unreviewed Wasm import kind " + kind);
    }
  } else if (section === 5) definedMemories = uint();
  assert.ok(at <= end); at = end;
}
assert.deepEqual(memoryImports, [{ namespace: "env", field: "memory", flags: 1, initial: 1024, maximum: 1024 }]);
assert.equal(definedMemories, 0);
const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
const publicABI = exports.filter((item) => item.name.startsWith("aurialis_"));
assert.deepEqual(publicABI.map((item) => item.name).sort(), ["abi", "open", "next", "output", "rate", "channels", "frames", "close"].map((name) => "aurialis_decoder_" + name).sort());
assert.ok(publicABI.every((item) => item.kind === "function"));
assert.ok(!exports.some((item) => item.name.includes("test_case") || item.name.includes("test_count")));
const configuration = await readFile(root + "/ffbuild/config.h", "utf8");
const componentsText = await readFile(root + "/ffbuild/config_components.h", "utf8");
const components = {};
for (const category of ["DECODER", "DEMUXER", "PARSER", "ENCODER", "MUXER", "FILTER", "PROTOCOL", "INDEV", "OUTDEV", "HWACCEL", "BSF"]) components[category] = [...componentsText.matchAll(new RegExp("^#define CONFIG_([A-Z0-9_]+)_" + category + " 1$", "gm"))].map((item) => item[1]);
const flags = {};
for (const name of ["CONFIG_GPL", "CONFIG_NONFREE", "CONFIG_VERSION3", "CONFIG_NETWORK", "HAVE_PTHREADS", "HAVE_W32THREADS", "HAVE_OS2THREADS"]) { flags[name] = Number(configuration.match(new RegExp("^#define " + name + " ([01])$", "m"))?.[1]); assert.equal(flags[name], 0); }
const glueItem = manifest.assets.find((item) => /^decoder-core\.[a-f0-9]{64}\.mjs$/.test(item.path));
const glue = await readFile(root + "/assets/" + glueItem.path, "utf8");
assert.ok(!/\beval\s*\(|\bnew\s+Function\b/.test(glue));
const relink = [];
for (const name of (await readdir(root + "/relink")).sort()) { const b = await readFile(root + "/relink/" + name); relink.push({ path: name, bytes: b.length, sha256: sha(b) }); }
let reused = null;
try { reused = JSON.parse(await readFile(root + "/relink-inputs.json", "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of ["libavformat.a", "libavcodec.a", "libswresample.a", "libavutil.a"]) {
  if (reused) assert.equal(reused.archivesAndObject.find((item) => item.path === name)?.sha256, relink.find((item) => item.path === name)?.sha256);
  else assert.equal(sha(await readFile(root + "/install/lib/" + name)), relink.find((item) => item.path === name)?.sha256);
}
const symbols = await readFile(root + "/static-symbols.txt", "utf8");
const disclosedInternalHelpers = symbols.split("\n").filter((line) => /dirac|ogm_video|theora|vp8/.test(line));
const receipt = { status: "private-compiled-unqualified", runtimeCoreInstantiated: false, compressedParsing: false, audioDecoding: false,
  wasm: wasmItem, glue: glueItem, assetBytes: total, memoryImports, definedMemories, imports, exports,
  flags, components, relink, disclosedInternalHelpers, generatedGlueNoEvalConstructorPattern: true,
  sourceRecipeHashes: JSON.parse(await readFile(root + "/recipe-sha256.json", "utf8")),
  licenseDistributionApproval: false };
await writeFile(root + "/module-inspection.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ status: receipt.status, wasmBytes: wasmItem.bytes, wasmSHA256: wasmItem.sha256, glueBytes: glueItem.bytes, assetBytes: total, imports: imports.length, exports: exports.length, memoryImports, relinkFiles: relink.length, disclosedInternalHelpers }, null, 2));
