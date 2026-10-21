// cspell:ignore requestfailed requestfinished
import { expect, test } from "@playwright/test";
import { fixture } from "./audio-fixture";
import { observeOutput, outputLevel } from "./live-output";

test("a full song over 35 MB imports in one bounded request and survives reopening", async ({ page }, info) => {
  test.setTimeout(90_000);
  const started = Date.now();
  const stages: { name: string; startedMs: number; finishedMs?: number }[] = [];
  const events: unknown[] = [];
  const timed = async (name: string, action: () => Promise<unknown>) => {
    const stage = { name, startedMs: Date.now() - started } as (typeof stages)[number];
    stages.push(stage);
    try { return await action(); } finally { stage.finishedMs = Date.now() - started; }
  };
  page.on("crash", () => { events.push({ type: "crash", elapsedMs: Date.now() - started }); });
  page.on("pageerror", (error) => { events.push({ type: "pageerror", elapsedMs: Date.now() - started, message: error.message }); });
  page.on("requestfailed", (request) => { events.push({ type: "requestfailed", elapsedMs: Date.now() - started, url: request.url(), failure: request.failure() }); });
  page.on("requestfinished", (request) => {
    if (request.url().includes("/api/")) events.push({ type: "requestfinished", elapsedMs: Date.now() - started, timing: request.timing() });
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/")) events.push({ type: "response", elapsedMs: Date.now() - started,
      url: response.url(), status: response.status(), bytes: response.headers()["content-length"] });
  });
  await page.addInitScript(() => {
    const diagnostics: unknown[] = [];
    const observed = window as Window & { qaStorageDiagnostics?: unknown[] };
    observed.qaStorageDiagnostics = diagnostics;
    const record = (type: string, details: object) => { diagnostics.push({ type, time: performance.now(), ...details }); };
    function trackRequest<T>(type: string, request: IDBRequest<T>, started: number) {
      request.addEventListener("success", () => { record(type, { elapsedMs: performance.now() - started,
        bytes: request.result instanceof Blob ? request.result.size : null }); });
      request.addEventListener("error", () => { record(`${type}-error`, { elapsedMs: performance.now() - started, error: request.error?.message }); });
      request.transaction?.addEventListener("abort", () => { record(`${type}-abort`, { elapsedMs: performance.now() - started }); });
    };
    const nativeGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query) {
      const request = nativeGet.call(this, query); trackRequest("idb-get", request, performance.now()); return request;
    };
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = nativePut.call(this, value, key); trackRequest("idb-put", request, performance.now()); return request;
    };
    const nativeArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      const started = performance.now(); record("blob-read-start", { bytes: this.size });
      try { const result = await nativeArrayBuffer.call(this); record("blob-read-end", { bytes: this.size, elapsedMs: performance.now() - started }); return result; }
      catch (error) { record("blob-read-error", { bytes: this.size, elapsedMs: performance.now() - started, error: String(error) }); throw error; }
    };
  });
  let requests = 0;
  let browserBeforeReload: unknown;
  try {
    await observeOutput(page);
    await timed("initial-home", () => page.goto("/"));
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/master/render") requests++;
    });
    const fixtureStarted = Date.now() - started;
    const buffer = fixture(997, 200);
    stages.push({ name: "generate-fixture", startedMs: fixtureStarted, finishedMs: Date.now() - started });
    expect(buffer.length).toBeGreaterThan(35 * 1024 * 1024);
    await timed("upload-transfer", () => page.getByLabel("Upload audio file").setInputFiles({ name: "full-song.wav", mimeType: "audio/wav", buffer }));
    await timed("import-navigation", () => expect(page).toHaveURL(/\/master\/track-/, { timeout: 60_000 }));
    await timed("initial-ready", () => expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 }));
    await expect(page.getByRole("slider", { name: "Track playback position", exact: true })).toHaveAttribute("aria-valuemax", "200");
    const url = page.url();
    browserBeforeReload = await page.evaluate(() => ({
      storage: (window as Window & { qaStorageDiagnostics?: unknown[] }).qaStorageDiagnostics,
      memory: (() => { const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory; return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null; })(),
    }));
    await timed("reload-navigation", () => page.reload());
    await timed("reload-url", () => expect(page).toHaveURL(url));
    await timed("reload-ready", () => expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 }));
    expect(requests).toBe(1);
    await timed("play", () => page.getByRole("button", { name: "Play", exact: true }).click());
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
    await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-40);
  } finally {
    const browser = await page.evaluate(() => ({
      storage: (window as Window & { qaStorageDiagnostics?: unknown[] }).qaStorageDiagnostics,
      memory: (() => { const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory; return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null; })(),
      readyState: document.readyState, url: location.href,
      statuses: Array.from(document.querySelectorAll('[role="status"],[role="alert"]')).map((element) => element.textContent),
      transport: Object.fromEntries(Array.from(document.querySelector(".transport")?.attributes ?? []).map((attribute) => [attribute.name, attribute.value])),
      savedStateBytes: localStorage.getItem("aurialis-state-v1")?.length,
    })).catch((error: unknown) => ({ captureError: String(error) }));
    await info.attach("large import phase diagnostics", { body: JSON.stringify({ elapsedMs: Date.now() - started, stages, requests, events, browserBeforeReload, browser }, null, 2), contentType: "application/json" });
  }
});
