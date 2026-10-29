import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { startBrowserQA } from "./serve-browser-qa.mjs";

process.env.NODE_ENV = "test";
process.env.AURIALIS_BROWSER_QA = "1";
async function upstream(handler = (_request, response) => { response.end("upstream"); }) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { port: server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
async function setup(t, handler, timeoutMs) {
  const origin = await upstream(handler);
  const proxy = await startBrowserQA({ testOnly: { listenPort: 0, upstreamPort: origin.port, ...(timeoutMs ? { timeoutMs } : {}) } });
  t.after(async () => { await proxy.close(); await origin.close(); });
  return { origin, proxy };
}
function raw(url, path, { method = "GET", host } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: parsed.port, path, method, headers: { Host: host ?? parsed.host } }, (response) => {
      const chunks = []; response.on("data", (chunk) => { chunks.push(chunk); });
      response.on("end", () => { resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }); });
    });
    request.on("error", reject); request.end();
  });
}

test("requires explicit QA opt-in and confines test overrides", async () => {
  delete process.env.AURIALIS_BROWSER_QA;
  await assert.rejects(startBrowserQA(), /AURIALIS_BROWSER_QA=1/u);
  process.env.AURIALIS_BROWSER_QA = "1";
  process.env.NODE_ENV = "production";
  await assert.rejects(startBrowserQA({ testOnly: { listenPort: 0, upstreamPort: 1 } }), /NODE_ENV=test/u);
  process.env.NODE_ENV = "test";
  await assert.rejects(startBrowserQA({ testOnly: { listenPort: 3928, upstreamPort: 3927 } }), /ephemeral loopback/u);
  for (const upstreamPort of [-1, 0, 65536, 1.5, "3927", "example.com"]) await assert.rejects(startBrowserQA({ testOnly: { listenPort: 0, upstreamPort } }), /bounded loopback/u);
});

test("serves exactly the bounded repository observer on GET and HEAD", async (t) => {
  let calls = 0;
  const { proxy } = await setup(t, (_request, response) => { calls++; response.writeHead(404); response.end("production 404"); });
  const fixture = await readFile(new URL("../e2e/support/actual-output-tap.js", import.meta.url), "utf8");
  const response = await fetch(`${proxy.url}/__qa/actual-output-tap.js`);
  assert.equal(response.status, 200); assert.equal(await response.text(), fixture);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  const head = await fetch(`${proxy.url}/__qa/actual-output-tap.js`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(calls, 0);
  for (const path of ["/__qa/other.js", "/__qa/actual-output-tap.js?extra=1", "/__qa/actual-output-tap.js/"]) assert.equal((await fetch(proxy.url + path)).status, 404);
  assert.equal(calls, 3);
});

test("forwards production CSP and isolation while removing decompression and hop headers", async (t) => {
  const content = "production streamed app bytes";
  let target, method;
  const { proxy } = await setup(t, (request, response) => {
    target = request.url; method = request.method;
    const zipped = gzipSync(content);
    response.writeHead(200, {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY", "Cache-Control": "no-store, no-transform",
      "Content-Encoding": "gzip", "Content-Length": zipped.length, Connection: "x-private-hop", "X-Private-Hop": "remove",
    });
    response.end(request.method === "HEAD" ? undefined : zipped);
  });
  const response = await raw(proxy.url, "/master/track-1?view=audio");
  assert.equal(target, "/master/track-1?view=audio"); assert.equal(response.body, content);
  assert.equal(response.headers["content-security-policy"], "default-src 'self'; script-src 'self'; frame-ancestors 'none'");
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cache-control"], "no-store, no-transform");
  assert.equal(response.headers["content-encoding"], undefined); assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.headers["x-private-hop"], undefined);
  const head = await raw(proxy.url, "/index.html", { method: "HEAD" });
  assert.equal(method, "HEAD"); assert.equal(head.body, "");
});

test("rejects upload methods, external targets, encoded paths and rebinding hosts without contacting upstream", async (t) => {
  let calls = 0;
  const { proxy } = await setup(t, (_request, response) => { calls++; response.end("should not happen"); });
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await raw(proxy.url, "/", { method });
    assert.equal(response.status, 405); assert.equal(response.headers.allow, "GET, HEAD");
  }
  for (const path of ["http://example.com/", "//example.com/", "/%2e%2e/__qa/actual-output-tap.js", "/%5f%5fqa/actual-output-tap.js", "/__qa%2factual-output-tap.js", "/__qa%255c/actual-output-tap.js", "/../__qa/actual-output-tap.js", "/__qa\\actual-output-tap.js"]) assert.equal((await raw(proxy.url, path)).status, 400);
  assert.equal((await raw(proxy.url, "/", { host: "example.com" })).status, 400);
  assert.equal(calls, 0);
});

test("does not follow an upstream external redirect", async (t) => {
  const { proxy } = await setup(t, (_request, response) => { response.writeHead(302, { Location: "http://example.invalid/" }); response.end(); });
  const response = await raw(proxy.url, "/redirect");
  assert.equal(response.status, 302); assert.equal(response.headers.location, "http://example.invalid/");
});

test("returns bounded failures and stops only its own listener", async (t) => {
  const { proxy, origin } = await setup(t);
  await origin.close();
  const response = await fetch(`${proxy.url}/unavailable`);
  assert.equal(response.status, 502); assert.match(await response.text(), /upstream is unavailable/u);
  await proxy.close(); await proxy.close();
  await assert.rejects(fetch(`${proxy.url}/__qa/actual-output-tap.js`));
});

test("deadlines abort an upstream that never sends headers", async (t) => {
  const { proxy } = await setup(t, () => undefined, 30);
  const response = await fetch(`${proxy.url}/blocked`);
  assert.equal(response.status, 502);
});

test("streams the first bytes and aborts the upstream on client disconnect", async (t) => {
  let aborted;
  const disconnected = new Promise((resolve) => { aborted = resolve; });
  const { proxy } = await setup(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" }); response.write("first chunk");
    response.on("close", () => { aborted(); });
  });
  const controller = new AbortController();
  const response = await fetch(`${proxy.url}/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "first chunk");
  controller.abort();
  await Promise.race([disconnected, new Promise((_resolve, reject) => { const timer = setTimeout(() => { reject(new Error("Upstream was not aborted")); }, 1000); timer.unref(); })]);
});

test("CLI SIGTERM closes the proxy while leaving the caller-owned upstream running", async (t) => {
  const origin = await upstream(); t.after(origin.close);
  const child = spawn(process.execPath, [new URL("./serve-browser-qa.mjs", import.meta.url).pathname, `--test-ports=0,${origin.port}`], { env: { ...process.env, AURIALIS_BROWSER_QA: "1", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exit = once(child, "exit");
  let output = "";
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { output += chunk; const found = /proxy: (http:\/\/127\.0\.0\.1:[0-9]+)/u.exec(output); if (found) resolve(found[1]); });
    child.once("error", reject); child.once("exit", (code) => { reject(new Error(`Proxy exited before startup: ${code}`)); });
  });
  assert.equal((await fetch(`${url}/__qa/actual-output-tap.js`)).status, 200);
  child.kill("SIGTERM"); const [code, signal] = await exit;
  assert.equal(code, 0); assert.equal(signal, null);
  await assert.rejects(fetch(url));
  assert.equal(await (await fetch(`http://127.0.0.1:${origin.port}/`)).text(), "upstream");
});
