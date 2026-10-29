#!/usr/bin/env node
// Test-only same-origin observer delivery. Wrangler remains caller-owned.
import http from "node:http";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const QA_PATH = "/__qa/actual-output-tap.js";
const FIXTURE = new URL("../e2e/support/actual-output-tap.js", import.meta.url);
const MAX_FIXTURE = 64 * 1024;
const MAX_TIMEOUT = 65_000;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length"]);

async function observer() {
  const handle = await open(FIXTURE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FIXTURE) throw new Error("QA observer must be a regular file of at most 64 KiB.");
    const buffer = Buffer.alloc(MAX_FIXTURE + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_FIXTURE) throw new Error("QA observer exceeds 64 KiB.");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

function secure(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
}
function fail(request, response, status, message) {
  secure(response); response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(request.method === "HEAD" ? undefined : message);
}
function port(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) throw new Error("QA ports must be bounded loopback TCP ports.");
  return value;
}

/** Test port/timeout overrides are unavailable to normal command-line runs. */
export async function startBrowserQA({ testOnly } = {}) {
  if (process.env.AURIALIS_BROWSER_QA !== "1") throw new Error("Set AURIALIS_BROWSER_QA=1 to enable the test-only browser observer proxy.");
  if (testOnly && process.env.NODE_ENV !== "test") throw new Error("QA proxy test overrides require NODE_ENV=test.");
  if (testOnly && testOnly.listenPort !== 0) throw new Error("QA test listeners must request an ephemeral loopback port with listenPort=0.");
  const listenPort = testOnly ? port(testOnly.listenPort, true) : 3928;
  const upstreamPort = testOnly ? port(testOnly.upstreamPort) : 3927;
  const timeoutMs = testOnly?.timeoutMs ?? MAX_TIMEOUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw new Error("QA upstream deadlines must be between 1 and 65000 ms.");
  const fixture = await observer();
  const active = new Set();
  const server = http.createServer({ maxHeaderSize: 32 * 1024, requestTimeout: MAX_TIMEOUT, headersTimeout: 10_000 }, async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      fail(request, response, 405, "Aurialis processes audio on your device. This site accepts no uploads."); return;
    }
    const raw = request.url ?? "";
    const pathname = raw.split("?")[0];
    const localHost = `127.0.0.1:${server.address().port}`;
    // Do not let URL normalization turn absolute, encoded or traversal forms
    // into an observer route or a different network destination.
    if (request.headers.host !== localHost || !raw.startsWith("/") || raw.startsWith("//") || /[\\#\u0000-\u0020\u007f]/u.test(raw)
      || pathname.includes("%") || pathname.split("/").some((part) => part === "." || part === "..")) {
      fail(request, response, 400, "Invalid local QA request target."); return;
    }
    if (raw === QA_PATH) {
      secure(response); response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : fixture); return;
    }
    const controller = new AbortController(); active.add(controller);
    const deadline = setTimeout(() => { controller.abort(new Error("QA upstream timeout")); }, timeoutMs);
    const disconnect = () => { if (!response.writableFinished) controller.abort(new Error("QA client disconnected")); };
    response.once("close", disconnect);
    try {
      const headers = new Headers();
      const connection = new Set(String(request.headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()));
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== "host" && !HOP_HEADERS.has(name) && !connection.has(name) && !name.startsWith("proxy-")) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("Accept-Encoding", "identity");
      const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${raw}`, { method: request.method, headers, redirect: "manual", signal: controller.signal });
      response.statusCode = upstream.status;
      const excluded = new Set([...HOP_HEADERS, ...String(upstream.headers.get("connection") ?? "").toLowerCase().split(",").map((name) => name.trim())]);
      for (const [name, value] of upstream.headers) if (!excluded.has(name)) response.setHeader(name, value);
      if (request.method === "HEAD" || !upstream.body) { await upstream.body?.cancel(); response.end(); }
      else await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
    } catch {
      if (!response.headersSent && !response.destroyed) fail(request, response, 502, "The local browser QA upstream is unavailable.");
      else if (!response.destroyed) response.destroy();
    } finally {
      clearTimeout(deadline); response.removeListener("close", disconnect); active.delete(controller);
    }
  });
  server.on("connect", (_request, socket) => { socket.end("HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  let closing;
  const close = () => {
    if (!closing) closing = new Promise((resolve, reject) => {
      for (const controller of active) controller.abort(new Error("QA proxy shutting down"));
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    });
    return closing;
  };
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !/^--test-ports=0,[0-9]{1,5}$/u.test(args[0]))) throw new Error("Only the explicit ephemeral test-port option is supported.");
    const testOnly = args.length ? { listenPort: 0, upstreamPort: Number(args[0].split(",")[1]) } : undefined;
    const proxy = await startBrowserQA({ testOnly });
    console.log(`Test-only browser QA proxy: ${proxy.url} -> http://127.0.0.1:3927`);
    const stop = () => { void proxy.close().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
