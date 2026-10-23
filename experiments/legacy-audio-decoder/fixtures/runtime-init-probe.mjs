/* Private real-browser no-open probe. Never passes audio or calls decoder_open. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const [root, repo] = process.argv.slice(2);
if (!root || !repo) throw new Error("Pass private output and repository paths.");
const { chromium } = createRequire(repo + "/package.json")("@playwright/test");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(await readFile(root + "/assets/assets.json", "utf8"));
assert.equal(manifest.status, "private-unqualified"); assert.equal(manifest.distributionApproved, false);
const core = manifest.assets.find((item) => /^decoder-core\.[a-f0-9]{64}\.mjs$/.test(item.path));
const wasm = manifest.assets.find((item) => /^decoder-core\.[a-f0-9]{64}\.wasm$/.test(item.path));
assert.ok(core && wasm && wasm.bytes <= 16 * 1024 * 1024);
const files = new Map();
for (const entry of [core, wasm]) {
  const bytes = await readFile(root + "/assets/" + entry.path);
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  files.set("/" + entry.path, { bytes, mime: entry.path.endsWith(".wasm") ? "application/wasm" : "application/javascript" });
}
const workerSource = `import create from ${JSON.stringify("./" + core.path)};
let core;
try {
  const response = await fetch(${JSON.stringify("./" + wasm.path)}, { cache: "no-store" });
  if (!response.ok) throw new Error("Fixture WASM GET failed.");
  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  if (wasmBinary.length !== ${wasm.bytes}) throw new Error("Fixture WASM byte mismatch.");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", wasmBinary)), (b) => b.toString(16).padStart(2, "0")).join("");
  if (hash !== ${JSON.stringify(wasm.sha256)}) throw new Error("Fixture WASM hash mismatch.");
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 1024 });
  let reads = 0;
  core = await create({ wasmBinary, wasmMemory: memory, print: () => {}, printErr: () => {}, readInput: () => { reads++; return -1; } });
  const exports = ["abi", "open", "next", "output", "rate", "channels", "frames", "close"];
  if (!exports.every((name) => typeof core["_aurialis_decoder_" + name] === "function")) throw new Error("Missing runtime ABI export.");
  if (core.HEAPU8.buffer !== memory.buffer) throw new Error("Runtime allocated or used a different memory.");
  if (memory.buffer.byteLength !== 67108864 || core._aurialis_decoder_abi() !== 1 || reads !== 0) throw new Error("No-open runtime geometry/ABI/input contract failed.");
  let rejected = false;
  try { memory.grow(1); } catch (error) { rejected = error instanceof RangeError; }
  if (!rejected || memory.buffer.byteLength !== 67108864) throw new Error("Fixed imported memory grew.");
  core._aurialis_decoder_close();
  if (reads !== 0) throw new Error("No-open cleanup read input.");
  postMessage({ status: "pass", abi: 1, suppliedMemoryIdentity: true, memoryBytes: memory.buffer.byteLength, growRejected: rejected, inputReads: reads, exports, decoderOpened: false, compressedParsing: false, audioDecoding: false });
} catch (error) {
  postMessage({ status: "red", error: String(error?.message || error).slice(0, 1000), decoderOpened: false, compressedParsing: false, audioDecoding: false });
}`;
const pageSource = `globalThis.probe = { status: "pending" };
const worker = new Worker("./runtime-init.worker.mjs", { type: "module" });
const timer = setTimeout(() => { globalThis.probe = { status: "red", error: "No-open worker deadline." }; worker.terminate(); }, 15000);
worker.onmessage = (event) => { clearTimeout(timer); globalThis.probe = event.data; worker.terminate(); };
worker.onerror = (event) => { clearTimeout(timer); globalThis.probe = { status: "red", error: String(event.message).slice(0, 1000) }; worker.terminate(); };`;
files.set("/runtime-init.worker.mjs", { bytes: Buffer.from(workerSource), mime: "application/javascript" });
files.set("/runtime-init.mjs", { bytes: Buffer.from(pageSource), mime: "application/javascript" });
files.set("/", { bytes: Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><title>Private no-open WASM probe</title><script type="module" src="/runtime-init.mjs"></script></html>'), mime: "text/html" });
const headers = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cache-Control": "no-store",
};
const serverRequests = [], requests = [], blocked = [], errors = [];
const server = createServer((request, response) => {
  if (serverRequests.length >= 128) { response.writeHead(429); response.end(); return; }
  serverRequests.push({ method: request.method, path: request.url });
  const file = files.get(request.url);
  const status = !["GET", "HEAD"].includes(request.method) ? 405 : file ? 200 : 404;
  response.writeHead(status, { ...headers, "Content-Type": file?.mime || "text/plain", "Content-Length": status === 200 ? file.bytes.length : 0 });
  response.end(status === 200 && request.method !== "HEAD" ? file.bytes : undefined);
});
let browser, context, result;
const start = Date.now();
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, timeout: 15000 });
  context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const request = route.request(), url = request.url(), method = request.method();
    if (requests.length >= 128 || !["GET", "HEAD"].includes(method) || new URL(url).origin !== origin) {
      blocked.push({ method, url }); await route.abort(); return;
    }
    requests.push({ method, url }); await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 1000)));
  await page.goto(origin + "/", { waitUntil: "load", timeout: 15000 });
  await page.waitForFunction(() => globalThis.probe && globalThis.probe.status !== "pending", undefined, { timeout: 20000 });
  result = await page.evaluate(() => ({ ...globalThis.probe, crossOriginIsolated: globalThis.crossOriginIsolated }));
  assert.equal(result.status, "pass"); assert.equal(result.crossOriginIsolated, true);
  assert.equal(result.suppliedMemoryIdentity, true); assert.equal(result.memoryBytes, 67108864);
  assert.equal(result.inputReads, 0); assert.equal(result.decoderOpened, false);
  assert.equal(blocked.length, 0); assert.equal(errors.length, 0);
  result.browserVersion = browser.version();
} catch (error) {
  result = { ...(result || {}), status: "red", error: String(error?.message || error).slice(0, 2000) };
  process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  const receipt = { tier: "real-browser-worker-no-open", elapsedMs: Date.now() - start, result, requests, serverRequests, blocked, errors, headers,
    sources: { probeSHA256: sha(await readFile(new URL(import.meta.url))), workerSHA256: sha(Buffer.from(workerSource)), pageSHA256: sha(Buffer.from(pageSource)), core, wasm },
    compressedParsing: false, audioDecoding: false, distributionApproved: false };
  await writeFile(root + "/runtime-init-result.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
