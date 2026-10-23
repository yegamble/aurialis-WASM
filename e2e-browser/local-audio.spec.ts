/* Test-owned Playwright download/artifact paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { expect, test } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fixture, decode } from "../e2e/audio-fixture";
import { engineParams } from "../src/lib/browser-engine";
import type { AdvancedParams } from "../src/lib/types";

/** Real Cloudflare static Worker, real browser Go WASM, no HTTP audio server. */
test("imports, measures and exports native-equivalent PCM with zero audio network requests", async ({ page, context }, info) => {
  const forbidden: string[] = [];
  context.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method()) || request.postDataBuffer()?.length) forbidden.push(request.method() + " " + request.url()); });
  const response = await page.goto("/");
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const source = fixture(997, 1);
  await page.getByLabel("Upload audio file").setInputFiles({ name: "browser-private.wav", mimeType: "audio/wav", buffer: source });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  const advanced = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { advanced: AdvancedParams }[] };
    const track = state.tracks[0]; if (!track) throw new Error("Missing imported local source"); return track.advanced;
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const downloading = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const downloaded = await downloading, path = await downloaded.path();
  expect(await downloaded.failure()).toBeNull(); if (!path) throw new Error("Missing browser-local export");
  const output = await readFile(path);
  const directory = info.outputPath("native-oracle"); await mkdir(directory, { recursive: true });
  await writeFile(directory + "/source.wav", source); await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", params: JSON.stringify(engineParams(advanced)), bitDepth: 32 }));
  execFileSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe" });
  const native = await readFile(directory + "/native.wav");
  expect(output).toEqual(native);
  expect(decode(output).left.length).toBe(48_000);
  expect(forbidden).toEqual([]);
  const evidence = info.outputPath("local-only-network-evidence.json");
  await writeFile(evidence, JSON.stringify({ forbidden, exportedBytes: output.length, nativeBytes: native.length, exactPCM: true }, null, 2));
  await info.attach("local-only-network-evidence", { path: evidence, contentType: "application/json" });
});

test("rejects hostile audio in actual Go WASM without sending a network body", async ({ page, context }) => {
  const requests: string[] = [];
  context.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method()) || request.postDataBuffer()?.length) requests.push(request.url()); });
  await page.goto("/");
  const hostile = Buffer.concat([fixture(997, .1), Buffer.from("%PDF- hidden payload")]);
  await page.getByLabel("Upload audio file").setInputFiles({ name: "hostile.wav", mimeType: "audio/wav", buffer: hostile });
  await expect(page.getByText(/polyglot|payload|corrupt/iu)).toBeVisible({ timeout: 30_000 });
  expect(requests).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("rejects a stale real Go module before processing and retries with a fresh worker", async ({ page, context }) => {
  const forbidden: string[] = [];
  context.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method()) || request.postDataBuffer()?.length) forbidden.push(request.method() + " " + request.url()); });
  const stale = await readFile("artifacts/browser-local/stale-fixture.wasm");
  let served = 0;
  await context.route("**/wasm/aurialis-dsp.wasm", async (route) => {
    served++;
    if (served === 1) await route.fulfill({ status: 200, contentType: "application/wasm", body: stale });
    else await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name: "stale-engine.wav", mimeType: "audio/wav", buffer: fixture(997, .1) });
  await expect(page.getByText(/engine version is incompatible/iu)).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name: "fresh-engine.wav", mimeType: "audio/wav", buffer: fixture(997, .1) });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  expect(served).toBeGreaterThanOrEqual(2);
  expect(forbidden).toEqual([]);
});

test("serves exact dynamic HTML and RSC assets while rejecting API uploads and unknown files", async ({ request }) => {
  for (const route of ["master", "split", "albums", "reference", "release-check"]) {
    const html = await request.get(`/${route}/fresh-source`);
    expect(html.status()).toBe(200);
    expect(html.headers()["content-type"]).toContain("text/html");
    const rsc = await request.get(`/${route}/fresh-source.txt`);
    expect(rsc.status()).toBe(200);
    expect(await rsc.text()).not.toMatch(/<!doctype html/iu);
    expect((await request.get(`/${route}/fresh-source.wav`)).status()).toBe(404);
  }
  expect((await request.get("/missing-engine.js")).status()).toBe(404);
  expect((await request.get("/api/jobs/unknown")).status()).toBe(404);
  const rejected = await request.post("/api/master/render", { data: "non-audio method probe" });
  expect(rejected.status()).toBe(405);
  expect(rejected.headers().allow).toBe("GET, HEAD");
  const wasm = await request.head("/wasm/aurialis-dsp.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toBe("application/wasm");
  expect(wasm.headers()["cache-control"]).toBe("no-store");
  expect(await wasm.body()).toHaveLength(0);
});
