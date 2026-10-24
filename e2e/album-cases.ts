/* Paths belong to the bounded Playwright fixture/artifact scope, never audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
// cspell:words spinbutton
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo, type APIRequestContext } from "@playwright/test";
import { albumLinearParams, type AlbumReport } from "../src/lib/album-batch";
import { engineParams } from "../src/lib/browser-engine";
import type { Album, Track } from "../src/lib/types";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";

export async function workspace(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[]; albums: Album[] });
}
export async function openAlbum(page: Page, titles: string[]) {
  await page.goto("/albums"); await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  for (const title of titles) await page.getByRole("button", { name: title, exact: true }).click();
}
async function download(page: Page, name: string) {
  const waiting = page.waitForEvent("download"); await page.getByRole("button", { name, exact: true }).click();
  const path = await (await waiting).path(); if (!path) throw new Error("Missing album download"); return readFile(path);
}
export async function report(page: Page) { return JSON.parse((await download(page, "Download album JSON report")).toString()) as AlbumReport; }
async function run(page: Page, count: number) {
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.getByText(`${String(count)} of ${String(count)} verified masters.`, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
}


interface AlbumQA { finalOutputs: number; holdAt24: number | null; release: (() => void) | null; mismatch: boolean; outputAdds: number; failOutputAt: number | null; storageErrors: string[]; urls: { bytes: number; created: number; revoked: number | null; url: string }[]; jobs: { operation: string; format?: string; bitDepth?: number; sourceBytes: number; script?: string }[] }
declare global { interface Window { albumQA: AlbumQA } }
const browserRequests = new WeakMap<import("@playwright/test").BrowserContext, { url: string; method: string; bytes: number }[]>();
export async function observeAlbum(page: Page) {
  await page.addInitScript(() => {
    const state: AlbumQA = { finalOutputs: 0, holdAt24: null, release: null, mismatch: false, outputAdds: 0, failOutputAt: null, storageErrors: [], urls: [], jobs: [] }; window.albumQA = state;
    const record = (request: { operation: string; format?: string; bitDepth?: number; script?: string }, sourceBytes: number) => {
      if (state.jobs.length >= 128 || (request.script?.length ?? 0) > 65536) throw new Error("Album test observation exceeded its bound");
      state.jobs.push({ operation: request.operation, sourceBytes, ...(request.format !== undefined ? { format: request.format } : {}), ...(request.bitDepth !== undefined ? { bitDepth: request.bitDepth } : {}), ...(request.script !== undefined ? { script: request.script } : {}) });
    };
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).includes("/master/render") && init?.body instanceof FormData) {
        const body = init.body, file = body.get("file"), script = body.get("script"), format = body.get("format"), bits = body.get("bitDepth");
        record({ operation: "render", ...(typeof script === "string" ? { script } : {}), ...(typeof format === "string" ? { format } : {}), ...(typeof bits === "string" ? { bitDepth: Number(bits) } : {}) }, file instanceof Blob ? file.size : 0);
      }
      return fetch(input, init);
    };
    const WorkerConstructor = window.Worker;
    window.Worker = class extends WorkerConstructor {
      private hold = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as { kind?: string; processingBuild?: string };
          if (state.mismatch) { state.mismatch = false; data.processingBuild = "f".repeat(64); }
          if (this.hold && data.kind === "result") { this.hold = false; event.stopImmediatePropagation(); state.release = () => { state.release = null; this.dispatchEvent(new MessageEvent("message", { data })); }; }
        });
      }
      override postMessage(message: unknown, transfer: Transferable[]): void;
      override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
      override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
        const envelope = message as { metadata?: string; source?: ArrayBuffer };
        if (envelope.metadata) {
          const request = JSON.parse(envelope.metadata) as { operation: string; format?: string; bitDepth?: number; script?: string };
          record(request, envelope.source?.byteLength ?? 0);
          if (request.operation === "render" && request.bitDepth === 24) { state.finalOutputs++; this.hold = state.holdAt24 === state.finalOutputs; }
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer);
      }
    };
    // Preserve dynamic receiver for observational prototype interception.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with its original store receiver
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.transaction.db.name === "aurialis-album-spool-v1" && this.name === "outputs") {
        state.outputAdds++; if (state.failOutputAt === state.outputAdds) { state.failOutputAt = null; throw new DOMException("Album test quota denied", "QuotaExceededError"); }
      }
      return add.call(this, value, key);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with its original database receiver
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const actual = transaction.call(this, storeNames, mode, options);
      if (this.name === "aurialis-album-spool-v1" && mode === "readwrite") actual.addEventListener("abort", () => { if (state.storageErrors.length >= 16) throw new Error("Album storage observation exceeded its bound"); state.storageErrors.push(actual.error?.name ?? "unknown"); });
      return actual;
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); if (state.urls.length >= 128) throw new Error("Album URL observation exceeded its bound"); state.urls.push({ bytes: blob instanceof Blob ? blob.size : 0, created: performance.now(), revoked: null, url }); return url; };
    URL.revokeObjectURL = (url) => { const row = state.urls.find((entry) => entry.url === url); if (row) row.revoked = performance.now(); revoke(url); };
  });
}

async function holdEncoded(page: Page, execution: "native" | "browser", ordinal: number) {
  let count = 0, held = false, release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  if (execution === "browser") await page.evaluate((ordinal) => { window.albumQA.holdAt24 = ordinal; }, ordinal);
  else await page.route("**/api/master/render", async (route) => {
    const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    if (!/name="bitDepth"\r\n\r\n24\r\n/u.test(body)) { await route.continue(); return; }
    count++; if (count !== ordinal) { await route.continue(); return; }
    const response = await route.fetch(); held = true; await waiting; await route.fulfill({ response }).catch(() => undefined);
  });
  const free = async () => { release(); if (execution === "browser") await page.evaluate(() => { window.albumQA.release?.(); }); };
  return { held: async () => execution === "native" ? held : page.evaluate(() => !!window.albumQA.release), count: async () => execution === "native" ? count : page.evaluate(() => window.albumQA.finalOutputs), release: free, dispose: async () => { await free(); if (execution === "native") await page.unroute("**/api/master/render"); } };
}
async function storedAlbum(page: Page, albumId: string) {
  return page.evaluate(async (albumId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Stored Album database open failed")); }; });
    try { return await new Promise<{ manifest?: { prefix: { assetId: string; bytes: number; sha256: string }[]; pending: unknown; reserved: number }; budget: { bytes: number; reserved: number; runs: number }; outputs: number }>((resolve, reject) => {
      const transaction = database.transaction(["runs", "outputs"], "readonly"), runs = transaction.objectStore("runs"), manifest = runs.get(`album:${albumId}`), budget = runs.get("budget"), outputs = transaction.objectStore("outputs").count();
      transaction.oncomplete = () => { resolve({ manifest: manifest.result as { prefix: { assetId: string; bytes: number; sha256: string }[]; pending: unknown; reserved: number }, budget: budget.result as { bytes: number; reserved: number; runs: number }, outputs: outputs.result }); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Stored Album read transaction failed")); };
    }); } finally { database.close(); }
  }, albumId);
}
async function available(page: Page, albumId: string) { return page.evaluate((albumId) => navigator.locks.request(`aurialis-album:${albumId}`, { ifAvailable: true }, (lock) => !!lock), albumId); }

type RenderRequest = { params?: string; script?: string; bitDepth?: number; format?: string };
let oracleProducer: Promise<string> | null = null;
function compiledOracle(info: TestInfo) {
  oracleProducer ??= (async () => {
    await mkdir(info.project.outputDir, { recursive: true });
    const directory = await mkdtemp(join(info.project.outputDir, "album-oracle-producer-")), binary = join(directory, "browserjobs.test");
    execFileSync("go", ["test", "-c", "-o", binary, "./internal/browserjobs"], { stdio: "pipe", timeout: 120_000, maxBuffer: 1024 * 1024 });
    await writeFile(join(directory, "producer.json"), JSON.stringify({ binary, sha256: createHash("sha256").update(await readFile(binary)).digest("hex"), goVersion: execFileSync("go", ["version"], { encoding: "utf8" }).trim(), freshExecutionPerFixture: true }));
    return binary;
  })();
  return oracleProducer;
}

async function oracle(execution: "native" | "browser", request: APIRequestContext, source: Buffer, metadata: RenderRequest, info: TestInfo, label: string) {
  if (execution === "native") {
    const response = await request.post("/api/master/render", { multipart: { file: { name: "source.wav", mimeType: "audio/wav", buffer: source }, ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)])) } });
    expect(response.ok()).toBe(true); expect(response.headers()["x-aurialis-processing-build"]).toMatch(/^[a-f0-9]{64}$/u);
    return metadata.format === "json" ? { audio: Buffer.alloc(0), metadata: await response.json() as { afterMetrics: unknown } } : { audio: await response.body(), metadata: null };
  }
  const directory = info.outputPath(`album-native-oracle-${label}`); await mkdir(directory, { recursive: true });
  await writeFile(directory + "/source.wav", source); await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", ...metadata }));
  execFileSync(await compiledOracle(info), ["-test.run=^TestWriteBrowserOracle$", "-test.count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe", timeout: 65_000, maxBuffer: 1024 * 1024 });
  return { audio: await readFile(directory + "/native.wav"), metadata: JSON.parse(await readFile(directory + "/native.json", "utf8")) as { afterMetrics: unknown } };
}
export function registerAlbumCases(execution: "native" | "browser") {
  test.beforeEach(async ({ page }) => { await observeAlbum(page); });
  test.afterEach(async ({ context }, info) => {
    if (execution !== "browser") return;
    const inventory = browserRequests.get(context) ?? []; expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.filter((entry) => !["GET", "HEAD"].includes(entry.method) || entry.bytes > 0)).toEqual([]);
    expect(inventory.every((entry) => new URL(entry.url).origin === new URL(info.project.use.baseURL ?? "http://127.0.0.1:3927").origin)).toBe(true);
    await info.attach("album-local-network.json", { body: JSON.stringify(inventory), contentType: "application/json" });
  });
  test.beforeEach(({ context }) => {
    const inventory: { url: string; method: string; bytes: number }[] = []; browserRequests.set(context, inventory);
    context.on("request", (request) => { inventory.push({ url: request.url(), method: request.method(), bytes: request.postDataBuffer()?.length ?? 0 }); });
  });
test("album gain preserves every accepted chain and Deep script, then hashes and measures each exact native 24-bit output", async ({ page, request }, info) => {
  const first = await uploadProject(page, "album-static.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("2");
  const second = await uploadProject(page, "album-deep.wav");
  await page.getByRole("tab", { name: "deep", exact: true }).click(); await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Explicit UI-authored audible envelope over the real measured proposal, then normal Apply validation.
  await page.getByRole("combobox", { name: "Move target", exact: true }).selectOption("inputGainDb");
  await page.getByRole("combobox", { name: "Move operation", exact: true }).selectOption("add");
  await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).fill("-3"); await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).blur();
  await page.getByRole("spinbutton", { name: "Point 2 value", exact: true }).fill("3"); await page.getByRole("spinbutton", { name: "Point 2 value", exact: true }).blur();
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => (await workspace(page)).tracks.find((track) => track.id === second)?.deepMastering?.applied?.revision ?? 0).toBeGreaterThan(0);
  const original = (await workspace(page)).tracks;
  await openAlbum(page, ["album static", "album deep"]);
  await page.getByRole("combobox", { name: "Album target", exact: true }).selectOption("-18");
  await page.getByRole("slider", { name: "Manual gain for album deep", exact: true }).fill("1");
  await run(page, 2); const receipt = await report(page);
  expect(receipt.complete).toBe(true); expect(receipt.cohortIds).toEqual([first, second]); expect(receipt.mode).toBe("relationships");
  expect(receipt.tracks[1]?.gain.gainDb).toBeCloseTo((receipt.tracks[0]?.gain.gainDb ?? 0) + 1, 10);
  for (const trackId of [first, second]) {
    const track = original.find((item) => item.id === trackId), row = receipt.tracks.find((item) => item.id === trackId); if (!track || !row) throw new Error("Missing album source or receipt");
    const actual = await download(page, `Download ${track.title}`), repeated = await download(page, `Download ${track.title}`);
    expect(repeated).toEqual(actual); const pcm = decode(actual); expect(pcm.bits).toBe(24); expect(pcm.rate).toBe(48000); expect(pcm.left).toHaveLength(row.source.frames);
    expect(row.output.sha256).toBe(createHash("sha256").update(actual).digest("hex")); expect(row.output.bytes).toBe(actual.length);
    const chain = await oracle(execution, request, fixture(), { ...(track.deepMastering?.applied ? { script: JSON.stringify(track.deepMastering.applied) } : { params: JSON.stringify(engineParams(track.advanced)) }), bitDepth: 32 }, info, trackId + "-chain");
    if (track.deepMastering?.applied) {
      const staticChain = await oracle(execution, request, fixture(), { params: JSON.stringify(engineParams(track.advanced)), bitDepth: 32 }, info, trackId + "-static-control");
      const automated = decode(chain.audio), baseline = decode(staticChain.audio); let difference = 0, energy = 0;
      for (let frame = 0; frame < automated.left.length; frame++) { difference += ((automated.left.at(frame) ?? 0) - (baseline.left.at(frame) ?? 0)) ** 2; energy += (baseline.left.at(frame) ?? 0) ** 2; }
      expect(Math.sqrt(difference / energy)).toBeGreaterThan(0.05);
      const scripts = await page.evaluate(() => window.albumQA.jobs.filter((job) => job.operation === "render" && job.script).map((job) => JSON.parse(job.script ?? "{}") as { moves: unknown; source: unknown }));
      expect(scripts.length).toBeGreaterThanOrEqual(2); for (const submitted of scripts) { expect(submitted.moves).toEqual(track.deepMastering.applied.moves); expect(submitted.source).toEqual(track.deepMastering.applied.source); }
    }
    const native = await oracle(execution, request, chain.audio, { params: JSON.stringify(albumLinearParams(row.gain.gainDb)), bitDepth: 24 }, info, trackId + "-gain"); expect(actual).toEqual(native.audio);
    const measured = await oracle(execution, request, actual, { params: JSON.stringify({ bypass: true }), format: "json" }, info, trackId + "-encoded");
    if (execution === "native") expect(measured.metadata?.afterMetrics).toEqual(row.metrics);
    else {
      const measuredMetrics = new Map<string, unknown>(Object.entries(measured.metadata?.afterMetrics ?? {})); expect([...measuredMetrics.keys()].sort()).toEqual(Object.keys(row.metrics).sort());
      let maximumDiagnosticError = 0;
      for (const [key, value] of Object.entries(row.metrics)) {
        const target = measuredMetrics.get(key); if (typeof target !== "number" || !Number.isFinite(target)) throw new Error("Encoded diagnostic must be finite");
        if (key === "clippingSamples") expect(value).toBe(target); else { maximumDiagnosticError = Math.max(maximumDiagnosticError, Math.abs(value - target)); expect(Math.abs(value - target)).toBeLessThanOrEqual(1e-10); }
      }
      await info.attach(`album-final-diagnostics-${trackId}.json`, { body: JSON.stringify({ maximumDiagnosticError, metrics: row.metrics, native: measured.metadata }), contentType: "application/json" });
    }
    const peak = pcm.left.reduce((value, sample, index) => Math.max(value, Math.abs(sample), Math.abs(pcm.right.at(index) ?? 0)), 0);
    expect(row.metrics.samplePeakDbfs).toBeCloseTo(20 * Math.log10(peak), 8);
  }
  expect((await workspace(page)).tracks).toEqual(original);
  await info.attach("album-receipt.json", { body: JSON.stringify(receipt), contentType: "application/json" });
  await page.getByRole("button", { name: "Save album report", exact: true }).click();
  await expect.poll(async () => (await workspace(page)).albums[0]?.report?.bindingHash).toBe(receipt.bindingHash);
  expect(await download(page, "Download album static")).toEqual(await download(page, "Download album static"));
  await page.reload(); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download album static", exact: true })).toHaveCount(0); expect((await report(page)).tracks).toEqual(receipt.tracks);
  await page.getByRole("slider", { name: "Manual gain for album static", exact: true }).fill("-1"); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toHaveCount(0);
});

test("album management, all gain targets, populated charts and explicit reorder controls work at six accessible widths", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 1000 });
  const longTitle = `album ${"long".repeat(48)}`;
  await uploadProject(page, "album-one.wav"); await uploadProject(page, `${longTitle.replace(" ", "-")}.wav`);
  await openAlbum(page, ["album one", longTitle]);
  const target = page.getByRole("combobox", { name: "Album target", exact: true });
  for (const value of [-23, -18, -16, -14, -12, -9]) { await target.selectOption(String(value)); expect((await workspace(page)).albums[0]?.target).toBe(`${String(value).replace("-", "−")} LUFS`); }
  await target.selectOption("-18");
  const down = page.getByRole("button", { name: "Move album one down", exact: true }); await down.focus(); await page.keyboard.press("Enter");
  expect((await workspace(page)).albums[0]?.trackIds).toEqual((await workspace(page)).tracks.map((track) => track.id));
  await page.getByRole("button", { name: "Move album one up", exact: true }).click();
  const order = page.getByRole("list", { name: "Album running order", exact: true });
  await order.getByRole("listitem").filter({ has: page.getByRole("link", { name: "album one", exact: true }) }).dragTo(order.getByRole("listitem").filter({ has: page.getByRole("link", { name: longTitle, exact: true }) }));
  expect((await workspace(page)).albums[0]?.trackIds).toEqual((await workspace(page)).tracks.map((track) => track.id));
  await page.getByRole("button", { name: "Move album one up", exact: true }).click();
  await run(page, 2);
  for (const name of ["Loudness", "Tone", "Dynamics"]) { const control = page.getByRole("group", { name: "Consistency view", exact: true }).getByRole("button", { name, exact: true }); await control.focus(); await page.keyboard.press("Enter"); await expect(control).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("list", { name: `${name} text readings`, exact: true })).toContainText("album one"); }
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const targets = await page.locator("button:visible, input:visible, select:visible, a:visible").evaluateAll((elements) => elements.map((element) => ({ label: element.getAttribute("aria-label") ?? element.textContent, rect: element.getBoundingClientRect() })).filter((item) => item.rect.width > 0 && item.rect.height > 0).map((item) => ({ label: item.label, width: item.rect.width, height: item.rect.height })));
    expect(targets.filter((item) => item.width < 43.5 || item.height < 43.5), `${String(width)}px album targets`).toEqual([]);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(axe.violations, `${String(width)}px populated album`).toEqual([]);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`album-${String(width)}.png`), fullPage: true });
  }
  await page.goto("/albums"); await page.getByRole("button", { name: "Rename Untitled sequence 1", exact: true }).click();
  await page.getByLabel("Album name", { exact: true }).fill("A measured sequence"); await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("button", { name: "Delete A measured sequence", exact: true }).click(); await page.keyboard.press("Escape"); await expect(page.getByRole("link", { name: /A measured sequence/u })).toBeVisible();
  await page.getByRole("button", { name: "Delete A measured sequence", exact: true }).click(); await page.getByRole("button", { name: "Delete album", exact: true }).click();
  expect((await workspace(page)).albums).toHaveLength(0); expect((await workspace(page)).tracks).toHaveLength(2);
});

test("cancel keeps only a verified prefix, retry reuses it, and cohort edits invalidate every retained download", async ({ page }) => {
  await uploadProject(page, "prefix-one.wav"); await uploadProject(page, "prefix-two.wav"); await openAlbum(page, ["prefix one", "prefix two"]);
  const gate = await holdEncoded(page, execution, 2);
  try {
    await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect.poll(gate.held).toBe(true);
    await page.getByRole("button", { name: "Cancel album render", exact: true }).click(); await gate.release();
    await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Download prefix two", exact: true })).toHaveCount(0);
    expect((await report(page)).tracks).toHaveLength(1); const prefix = await download(page, "Download prefix one"); await run(page, 2);
    expect(await gate.count()).toBe(3); expect(await download(page, "Download prefix one")).toEqual(prefix);
    await page.getByRole("combobox", { name: "Album gain mode", exact: true }).selectOption("normalize"); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toHaveCount(0);
  } finally { await gate.dispose(); }
});

test("direct album import and an all-silent short sequence require explicit manual gain and keep diagnostic uncertainty", async ({ page }) => {
  await page.goto("/albums"); await page.getByRole("button", { name: "New album", exact: true }).click(); await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  const silent = fixture(1000, 0.1); silent.fill(0, 44);
  await page.getByLabel("Import album audio", { exact: true }).setInputFiles({ name: "silent-short.wav", mimeType: "audio/wav", buffer: silent });
  await expect(page.getByRole("link", { name: "silent short", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("No measurable tracks");
  await expect(page.getByRole("button", { name: "Download silent short", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Album gain mode", exact: true }).selectOption("manual");
  await page.getByRole("slider", { name: "Manual gain for silent short", exact: true }).fill("6"); await run(page, 1);
  const receipt = await report(page), row = receipt.tracks[0]; expect(receipt.medianTrackLufs).toBeNull(); expect(receipt.commonGainDb).toBeNull();
  expect(row?.gain).toMatchObject({ gainDb: 6, requestedLufs: null, measurable: false });
  expect(row?.output.encoding).toMatchObject({ frames: 4800, leadingSilenceFrames: 4800, trailingSilenceFrames: 4800 });
  expect(decode(await download(page, "Download silent short")).left).toHaveLength(4800);
  await expect(page.getByText("Review: Too quiet or short for a reliable loudness comparison.", { exact: true })).toBeVisible();
});


test("reloaded prefix recovery withholds all output authority, survives cancellation and excludes another actual tab", async ({ page, context }) => {
  await uploadProject(page, "recover-one.wav"); await uploadProject(page, "recover-two.wav"); await openAlbum(page, ["recover one", "recover two"]); await run(page, 2);
  const previous = await report(page), albumId = previous.albumId, original = await storedAlbum(page, albumId);
  await page.getByRole("button", { name: "Save album report", exact: true }).click(); await expect.poll(async () => (await workspace(page)).albums[0]?.report?.bindingHash).toBe(previous.bindingHash);
  await page.reload(); await expect(page.getByRole("region", { name: "Rendered album downloads" })).toBeVisible(); expect(await page.getByRole("button", { name: "Download recover one", exact: true }).count()).toBe(0);
  const gate = await holdEncoded(page, execution, 2); const competing = await context.newPage();
  try {
    await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect.poll(gate.held).toBe(true);
    await expect(page.getByRole("button", { name: /^Download recover /u })).toHaveCount(0); expect(await available(page, albumId)).toBe(false);
    await competing.goto(page.url()); await competing.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect(competing.locator("main").getByRole("alert")).toContainText("owned by another tab");
    await page.getByRole("button", { name: "Cancel album render", exact: true }).click(); await gate.release(); await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Download recover /u })).toHaveCount(0);
    await run(page, 2); expect(await gate.count()).toBe(4); const recovered = await report(page); expect(recovered.tracks.map((row) => row.output)).toEqual(previous.tracks.map((row) => row.output));
    expect((await storedAlbum(page, albumId)).manifest?.prefix).toEqual(original.manifest?.prefix);
    await page.getByRole("link", { name: "Albums", exact: true }).click(); await expect.poll(() => available(competing, albumId)).toBe(true);
    await run(competing, 2); expect((await report(competing)).tracks.map((row) => row.output)).toEqual(previous.tracks.map((row) => row.output));
  } finally { await gate.dispose(); await competing.close(); }
});
test("injected IndexedDB QuotaExceededError preserves only the verified prefix and releases unused demand before retry", async ({ page }) => {
  await uploadProject(page, "quota-one.wav"); await uploadProject(page, "quota-two.wav"); await openAlbum(page, ["quota one", "quota two"]);
  await page.evaluate(() => { window.albumQA.failOutputAt = 2; }); await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Album test quota denied"); await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
  const partial = await report(page), first = await storedAlbum(page, partial.albumId); expect(partial.tracks).toHaveLength(1); expect(first.outputs).toBe(1); expect(first.manifest?.pending).toBeNull(); expect(first.budget).toEqual({ version: 1, bytes: 288044, reserved: 0, runs: 1 });
  const prefix = await download(page, "Download quota one"); await run(page, 2); const finished = await storedAlbum(page, partial.albumId); expect(finished.outputs).toBe(2); expect(finished.manifest?.prefix[0]).toEqual(first.manifest?.prefix[0]); expect(await download(page, "Download quota one")).toEqual(prefix);
});
test("browser-enforced quota override aborts the actual output transaction and preserves the verified prefix", async ({ page, context }) => {
  await uploadProject(page, "browser-quota-one.wav"); await uploadProject(page, "browser-quota-two.wav"); await openAlbum(page, ["browser quota one", "browser quota two"]);
  const gate = await holdEncoded(page, execution, 2), cdp = await context.newCDPSession(page), origin = new URL(page.url()).origin;
  try {
    await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect.poll(gate.held, { timeout: 60_000 }).toBe(true);
    const albumId = (await workspace(page)).albums[0]?.id; if (!albumId) throw new Error("Missing actual quota cohort");
    const before = await storedAlbum(page, albumId); expect(before.manifest?.prefix).toHaveLength(1);
    const usage = await cdp.send("Storage.getUsageAndQuota", { origin });
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: usage.usage + 65536 });
    expect((await cdp.send("Storage.getUsageAndQuota", { origin })).overrideActive).toBe(true);
    await gate.release(); await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled({ timeout: 60_000 });
    expect(await page.evaluate(() => window.albumQA.storageErrors)).toContain("QuotaExceededError");
    const partial = await report(page), after = await storedAlbum(page, albumId); expect(partial.tracks).toHaveLength(1); expect(after.manifest?.prefix).toEqual(before.manifest?.prefix); expect(after.outputs).toBe(1); expect(after.manifest?.pending).toBeNull(); expect(after.budget.reserved).toBe(0);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin });
    await run(page, 2); expect((await storedAlbum(page, albumId)).manifest?.prefix[0]).toEqual(before.manifest?.prefix[0]);
  } finally { await cdp.send("Storage.overrideQuotaForOrigin", { origin }); await gate.dispose(); await cdp.detach(); }
});
test("an actual response identity change discards the owned generation before trusting new audio", async ({ page }) => {
  await uploadProject(page, "identity-one.wav"); await openAlbum(page, ["identity one"]); await run(page, 1); const previous = await report(page), previousStored = await storedAlbum(page, previous.albumId), before = (await workspace(page)).tracks;
  if (execution === "browser") await page.evaluate(() => { window.albumQA.mismatch = true; });
  else await page.route("**/api/master/render", async (route) => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), "x-aurialis-processing-build": "f".repeat(64) } }); }, { times: 1 });
  await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect(page.locator("main").getByRole("alert")).toContainText("could not confirm this processing build");
  await expect(page.getByRole("button", { name: "Download identity one", exact: true })).toHaveCount(0); const state = await storedAlbum(page, previous.albumId); expect(state.manifest).toBeUndefined(); expect(state.outputs).toBe(0); expect(await available(page, previous.albumId)).toBe(true); expect((await workspace(page)).tracks).toEqual(before);
  await run(page, 1); expect((await storedAlbum(page, previous.albumId)).manifest?.prefix[0]?.assetId).not.toBe(previousStored.manifest?.prefix[0]?.assetId);
});
test("download URL ownership survives navigation until actual revocation then releases the album lock", async ({ page }) => {
  await uploadProject(page, "url-one.wav"); await openAlbum(page, ["url one"]); await run(page, 1); const receipt = await report(page);
  const waiting = page.waitForEvent("download"); await page.getByRole("button", { name: "Download url one", exact: true }).click(); const file = await waiting; expect(await file.failure()).toBeNull();
  const observed = await page.evaluate(() => window.albumQA.urls.filter((row) => row.bytes === 288044).at(-1)); expect(observed?.revoked).toBeNull(); expect(await available(page, receipt.albumId)).toBe(false);
  await page.getByRole("link", { name: "Albums", exact: true }).click(); await expect.poll(() => available(page, receipt.albumId)).toBe(true);
  const finished = await page.evaluate(() => window.albumQA.urls.filter((row) => row.bytes === 288044).at(-1)); if (!finished || finished.revoked === null) throw new Error("Album download URL did not revoke"); expect(finished.revoked - finished.created).toBeGreaterThanOrEqual(900);
  const path = await file.path(); if (!path) throw new Error("Missing exact URL download"); expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(receipt.tracks[0]?.output.sha256);
});

}
