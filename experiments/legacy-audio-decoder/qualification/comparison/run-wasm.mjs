/* Private actual compressed-parse comparison. Run only after Chair release. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { comparePcm } from "./compare-pcm.mjs";
const [fixtures, nativeRoot, runtimeRoot, output, matrixPin, repo] = process.argv.slice(2);
if (!repo) throw new Error("Pass FIXTURES NATIVE_RESULTS RUNTIME05 NEW_OUTPUT MATRIX_PIN REPOSITORY.");
const MAX = 384001, start = Date.now(), sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { chromium } = createRequire(join(repo, "package.json"))("@playwright/test");
for (const path of [fixtures, nativeRoot, runtimeRoot, join(fixtures, "inputs"), join(fixtures, "references"), join(fixtures, "recipe"), join(runtimeRoot, "assets")]) {
  const info = await lstat(path); assert.ok(info.isDirectory() && !info.isSymbolicLink(), "No supplied or staged directory symlinks.");
}
const boundedRegular = async (path, limit) => {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= limit, "Bounded non-symlink regular file required.");
  return readFile(path);
};
const closedPath = (value, prefix) => {
  assert.ok(new RegExp("^" + prefix + "/[a-z0-9-]{1,64}\\.(?:mp3|flac|ogg|aac|m4a|f32le)$").test(value));
  return join(fixtures, value);
};
const manifestBytes = await boundedRegular(join(fixtures, "matrix.json"), 256 * 1024);
assert.equal(sha(manifestBytes), matrixPin);
const matrix = JSON.parse(manifestBytes);
assert.equal(matrix.schema, "aurialis-private-decoder-matrix-v1");
assert.equal(matrix.candidates.length, 24);
assert.equal(new Set(matrix.candidates.map((r) => r.id)).size, 24);
for (const row of matrix.candidates) {
  assert.match(row.id, /^[a-z0-9-]{1,64}$/);
  assert.match(row.file, new RegExp("^inputs/" + row.id + "\\.(?:mp3|flac|ogg|aac|m4a)$"));
  const data = await boundedRegular(closedPath(row.file, "inputs"), 2 * 1024 * 1024);
  assert.equal(data.length, row.bytes); assert.equal(sha(data), row.sha256);
}
for (const entry of matrix.recipe) {
  assert.match(entry.file, /^[a-z0-9-]+\.(?:py|mjs)$/);
  const bytes = await boundedRegular(join(fixtures, "recipe", entry.file), 128 * 1024);
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
}
// The imported comparison module and page source must be the exact frozen ones.
assert.equal(sha(await readFile(new URL(import.meta.url))), matrix.recipe.find((r) => r.file === "run-wasm.mjs").sha256);
assert.equal(sha(await readFile(new URL("./compare-pcm.mjs", import.meta.url))), matrix.recipe.find((r) => r.file === "compare-pcm.mjs").sha256);
const nativeResultBytes = await boundedRegular(join(nativeRoot, "native-results.json"), 2 * 1024 * 1024), nativeResult = JSON.parse(nativeResultBytes);
assert.equal(nativeResult.matrixSHA256, matrixPin); assert.equal(nativeResult.oracleSHA256, matrix.native.sha256);
assert.equal(nativeResult.cases.length, 24);
assert.equal(new Set(nativeResult.cases.map((r) => r.id)).size, 24);
const runtimeManifest = await boundedRegular(join(runtimeRoot, "assets/assets.json"), 16 * 1024);
assert.equal(sha(runtimeManifest), matrix.runtime.manifest.sha256);
const files = new Map();
for (const entry of matrix.runtime.assets.filter((r) => /^(?:decoder-core|decoder\.worker|envelope|bounded-read)\.[a-f0-9]{64}\.(?:mjs|wasm)$/.test(r.path))) {
  const bytes = await boundedRegular(join(runtimeRoot, "assets", entry.path), 16 * 1024 * 1024);
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  files.set("/" + entry.path, { bytes, mime: entry.path.endsWith(".wasm") ? "application/wasm" : "application/javascript" });
}
assert.equal(files.size, 5); assert.ok(files.has("/" + matrix.runtime.worker));
const pageSource = await boundedRegular(join(fixtures, "recipe/decode-page.mjs"), 16 * 1024);
files.set("/decode-page.mjs", { bytes: pageSource, mime: "application/javascript" });
files.set("/", { bytes: Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><title>Private generated-fixture comparison</title><label for="fixture">Generated fixture</label><input id="fixture" type="file"><script type="module" src="/decode-page.mjs"></script></html>'), mime: "text/html" });
const headers = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cache-Control": "no-store",
};
const requests = [], serverRequests = [], blocked = [], cases = [];
const server = createServer((request, response) => {
  if (serverRequests.length >= 4096) { response.writeHead(429); response.end(); return; }
  serverRequests.push({ method: request.method, path: request.url });
  const file = files.get(request.url), status = !["GET", "HEAD"].includes(request.method) ? 405 : file ? 200 : 404;
  response.writeHead(status, { ...headers, "Content-Type": file?.mime || "text/plain", "Content-Length": status === 200 ? file.bytes.length : 0 });
  response.end(status === 200 && request.method !== "HEAD" ? file.bytes : undefined);
});
await mkdir(output, { mode: 0o700 });
let browser, context, driverError;
const usage = async (directory) => {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Unexpected output symlink.");
    count += entry.isDirectory() ? await usage(path) : (await stat(path)).size;
  }
  return count;
};
try {
  assert.ok(await usage(nativeRoot) <= matrix.retainedBudget.nativePartitionBytes);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, timeout: 15000 });
  for (const row of matrix.candidates) {
    if (Date.now() - start > 900000 || await usage(output) > matrix.retainedBudget.wasmPartitionBytes) throw new Error("Browser suite wall/output guard.");
    const begin = Date.now(), expectedNative = nativeResult.cases.find((r) => r.id === row.id), event = { id: row.id, coverage: row.coverage, status: "red", execution: "unrun-native-failed", published: false, cdrCalled: false };
    const errors = [], beforeRequests = requests.length, beforeBlocked = blocked.length;
    try {
      assert.equal(expectedNative.exitCode, 0, "Native decode failed; comparison remains unrun.");
      assert.ok(expectedNative.firstActualFrame && expectedNative.complete && expectedNative.pcm);
      event.execution = "browser-setup";
      const nativePcmPath = join(nativeRoot, row.id + ".f32le"), nativePcm = await boundedRegular(nativePcmPath, MAX * 8);
      assert.equal(sha(nativePcm), expectedNative.pcm.sha256);
      context = await browser.newContext({ acceptDownloads: false });
      await context.route("**/*", async (route) => {
        const request = route.request(), url = request.url(), method = request.method();
        if (requests.length >= 4096 || !["GET", "HEAD"].includes(method) || new URL(url).origin !== origin) { blocked.push({ method, url }); await route.abort(); return; }
        requests.push({ id: row.id, method, url }); await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => { if (errors.length < 32) errors.push(error.message.slice(0, 1000)); });
      await page.goto(origin + "/", { waitUntil: "load", timeout: 15000 });
      await page.locator("#fixture").setInputFiles(closedPath(row.file, "inputs"));
      event.execution = "worker-start-attempted";
      await page.evaluate(({ worker, id }) => globalThis.decodeSelected(worker, id), { worker: "/" + matrix.runtime.worker, id: row.id });
      event.execution = "worker-started";
      await page.waitForFunction(() => globalThis.result.status !== "pending", undefined, { timeout: 135000 });
      const collected = await page.evaluate(() => globalThis.result);
      event.workerReceipt = { ...collected, audioBase64: undefined };
      assert.equal(collected.status, "decoded-unqualified", collected.error);
      event.execution = "worker-completed";
      assert.equal(collected.crossOriginIsolated, true); assert.equal(collected.published, false); assert.equal(collected.cdrCalled, false);
      assert.equal(collected.rate, expectedNative.firstActualFrame.rate); assert.equal(collected.channels, expectedNative.firstActualFrame.channels); assert.equal(collected.frames, expectedNative.complete.frames);
      assert.ok(typeof collected.audioBase64 === "string" && collected.audioBase64.length <= Math.ceil(MAX * 8 / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(collected.audioBase64));
      const pcm = Buffer.from(collected.audioBase64, "base64"); delete collected.audioBase64;
      assert.equal(pcm.length, collected.frames * 8); assert.equal(blocked.length, beforeBlocked); assert.deepEqual(errors, []);
      event.comparisonExecuted = true;
      event.comparison = comparePcm(pcm, nativePcm, { frames: collected.frames, channels: collected.channels }, matrix.criteria, Boolean(row.expected.losslessSource));
      if (row.expected.losslessSource) {
        assert.equal(row.expected.losslessSource.file, "references/" + row.id + ".f32le");
        const ref = await boundedRegular(closedPath(row.expected.losslessSource.file, "references"), MAX * 8);
        assert.equal(sha(ref), row.expected.losslessSource.sha256); assert.ok(nativePcm.equals(ref), "Native lossless source expectation failed.");
      }
      await writeFile(join(output, row.id + ".f32le"), pcm, { flag: "wx", mode: 0o600 });
      event.pcm = { bytes: pcm.length, sha256: sha(pcm) }; event.worker = collected;
      event.nativePolicyErrors = expectedNative.policyErrors;
      event.status = row.coverage === "diagnostic" ? "diagnostic-uncovered" : event.comparison.pass && expectedNative.policyErrors.length === 0 ? "pass" : "red";
      assert.equal(sha(await readFile(nativePcmPath)), expectedNative.pcm.sha256);
    } catch (error) { event.error = String(error?.message || error).slice(0, 2000); }
    finally { await context?.close(); context = null; }
    assert.equal(sha(await readFile(closedPath(row.file, "inputs"))), row.sha256);
    event.elapsedMs = Date.now() - begin; event.requests = requests.slice(beforeRequests); event.blocked = blocked.slice(beforeBlocked); event.errors = errors; cases.push(event);
    await writeFile(join(output, "wasm-results.json"), JSON.stringify({ tier: "actual-browser-worker-native9-pcm-comparison", matrixSHA256: matrixPin, nativeResultsSHA256: sha(nativeResultBytes), cases, distributionApproved: false, status: "running" }, null, 2) + "\n");
  }
} catch (error) { driverError = String(error?.message || error).slice(0, 2000); process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close(); await new Promise((resolve) => server.close(resolve));
  const status = !driverError && cases.length === 24 && cases.filter((r) => r.coverage === "positive").every((r) => r.status === "pass") && blocked.length === 0 ? "pass" : "red";
  if (status !== "pass") process.exitCode = 1;
  await writeFile(join(output, "wasm-results.json"), JSON.stringify({ tier: "actual-browser-worker-native9-pcm-comparison", status, driverError, matrixSHA256: matrixPin, nativeResultsSHA256: sha(nativeResultBytes), cases, elapsedMs: Date.now() - start, requests, serverRequests, blocked, headers, positiveCandidates: 23, diagnosticUncovered: ["adts-he-1"], cdrAndDurablePublication: "unrun-later-gate", distributionApproved: false }, null, 2) + "\n");
  console.log(JSON.stringify({ status, cases: cases.length, diagnosticUncovered: ["adts-he-1"], driverError }));
}
