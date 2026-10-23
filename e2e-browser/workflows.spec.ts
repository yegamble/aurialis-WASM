// cspell:words spinbutton
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fixture, decode } from "../e2e/audio-fixture";
import { engineParams } from "../src/lib/browser-engine";
import type { AdvancedParams, Track } from "../src/lib/types";
import type { ScriptV2 } from "../src/lib/deep-mastering";
import { captureDeepDevice, capturedDevice, capturedProgress } from "../e2e/deep-capture";

function observeNetwork(context: BrowserContext) {
  const requests: { method: string; url: string; bodyBytes: number }[] = [];
  context.on("request", (request) => { requests.push({ method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0 }); });
  return requests;
}
async function upload(page: Page, source: Buffer, name: string) {
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: source });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  const id = new URL(page.url()).pathname.split("/")[2];
  if (!id) throw new Error("Missing local project identity");
  return id;
}
async function settings(page: Page, id: string) {
  return page.evaluate((id) => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { id: string; advanced: AdvancedParams }[] };
    const track = state.tracks.find((item) => item.id === id);
    if (!track) throw new Error("Missing saved local project");
    return track.advanced;
  }, id);
}
async function nativeRender(info: TestInfo, source: Buffer, advanced: AdvancedParams, bitDepth: number, script?: ScriptV2) {
  const directory = info.outputPath("native-oracle");
  await mkdir(directory, { recursive: true });
  await writeFile(directory + "/source.wav", source);
  await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", ...(script ? { script: JSON.stringify(script) } : { params: JSON.stringify(engineParams(advanced)) }), bitDepth }));
  execFileSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe" });
  return { audio: await readFile(directory + "/native.wav"), metadata: JSON.parse(await readFile(directory + "/native.json", "utf8")) as { afterMetrics: { integratedLufs: number; samplePeakDbfs: number } } };
}
async function assertPrivate(info: TestInfo, requests: ReturnType<typeof observeNetwork>) {
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((request) => !["GET", "HEAD"].includes(request.method) || request.bodyBytes > 0)).toEqual([]);
  const origin = new URL(info.project.use.baseURL ?? "http://127.0.0.1:3927").origin;
  expect(requests.every((request) => new URL(request.url).origin === origin)).toBe(true);
  const path = info.outputPath("network-inventory.json");
  await writeFile(path, JSON.stringify(requests, null, 2));
  await info.attach("all-browser-and-worker-network-requests", { path, contentType: "application/json" });
}

test("measured Reference applies and exports the real local proposal with no audio requests", async ({ page, context }, info) => {
  const requests = observeNetwork(context);
  const source = fixture(997, 1), id = await upload(page, source, "private-reference-source.wav");
  const before = await settings(page, id);
  const reference = await upload(page, fixture(2800, 1), "private-reference-target.wav");
  await page.goto(`/reference/${id}`);
  await page.getByRole("combobox", { name: "Reference track", exact: true }).selectOption(reference);
  await page.getByRole("button", { name: "Analyze reference audio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply measured proposal", exact: true })).toBeEnabled({ timeout: 30_000 });
  expect(await settings(page, id)).toEqual(before);
  await page.getByRole("button", { name: "Apply measured proposal", exact: true }).click();
  await expect(page.getByText(/Measured proposal applied/u)).toBeVisible();
  const advanced = await settings(page, id);
  expect(advanced.eqBands).not.toEqual(before.eqBands);
  expect(advanced.stereo).toEqual(before.stereo);
  await page.getByRole("link", { name: "Back to master", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const downloaded = await downloading, path = await downloaded.path();
  if (!path) throw new Error("Missing measured Reference export");
  const native = await nativeRender(info, source, advanced, 32);
  expect(await readFile(path)).toEqual(native.audio);
  await assertPrivate(info, requests);
});

test("album WAVs and release measurements run on the device without an audio server", async ({ page, context }, info) => {
  const requests = observeNetwork(context);
  const source = fixture(997, 1), id = await upload(page, source, "private-album-source.wav");
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  await page.getByRole("button", { name: "private album source", exact: true }).click();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const ready = page.getByRole("button", { name: "Download private album source", exact: true });
  await expect(ready).toBeVisible({ timeout: 30_000 });
  const downloading = page.waitForEvent("download");
  await ready.click();
  const downloaded = await downloading, path = await downloaded.path();
  if (!path) throw new Error("Missing local album master");
  const rendered = await readFile(path);
  expect(decode(rendered).bits).toBe(24);
  const native = await nativeRender(info, source, await settings(page, id), 24);
  expect(rendered).toEqual(native.audio);
  await page.goto(`/release-check/${id}`);
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download JSON report", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`${native.metadata.afterMetrics.integratedLufs.toFixed(1)} LUFS`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${native.metadata.afterMetrics.samplePeakDbfs.toFixed(1)} dBFS`, { exact: true })).toBeVisible();
  await assertPrivate(info, requests);
});


test("Deep analysis compilation live apply and source-bound export keep every audio byte local", async ({ page, context }, info) => {
  const requests = observeNetwork(context);
  await captureDeepDevice(page, 48000);
  const source = fixture(997, 3), id = await upload(page, source, "private-deep-source.wav");
  const project = () => page.evaluate((id) => {
    const track = (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks.find((item) => item.id === id);
    if (!track) throw new Error("Missing Deep source project");
    return track;
  }, id);
  const original = await project();
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30_000 });
  const proposed = await project();
  expect(proposed.advanced).toEqual(original.advanced);
  expect(proposed.deepMastering?.proposal.source).toEqual(original.sourceIdentity);
  expect(proposed.deepMastering?.applied).toBeUndefined();
  expect(proposed.deepMastering?.proposal.moves).toHaveLength(0);
  await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  for (const point of [1, 2]) {
    const value = page.getByRole("spinbutton", { name: `Point ${String(point)} value`, exact: true });
    await value.fill("3");
    await value.blur();
  }
  await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  expect((await project()).advanced).toEqual(original.advanced);
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => (await project()).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(0);
  const accepted = await project(), applied = accepted.deepMastering?.applied;
  if (!applied) throw new Error("Missing accepted source-bound Deep script");
  expect(applied.source).toEqual(original.sourceIdentity);
  expect(applied.moves).toHaveLength(1);
  expect(applied.moves[0]?.points.map((point) => point.value)).toEqual([3, 3]);
  expect(accepted.deepMastering?.before?.advanced).toEqual(original.advanced);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await capturedProgress(page))?.frames ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(16384);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const capture = await capturedDevice(page);
  if (!capture) throw new Error("Missing actual local Deep playback PCM");
  expect(capture.missing).toBe(0);
  expect(capture.compiledMoves).toBe(applied.moves.length);
  const native = await nativeRender(info, source, accepted.advanced, 32, applied), pcm = decode(native.audio);
  let maximumLiveError = 0;
  for (let frame = 0; frame < 16384; frame++) {
    maximumLiveError = Math.max(maximumLiveError, Math.abs((pcm.left[frame] ?? Infinity) - (capture.outputLeft[frame] ?? 0)), Math.abs((pcm.right[frame] ?? Infinity) - (capture.outputRight[frame] ?? 0)));
  }
  expect(maximumLiveError).toBeLessThan(1e-6);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const downloaded = await downloading, path = await downloaded.path();
  if (!path) throw new Error("Missing browser-local Deep script export");
  expect(await downloaded.failure()).toBeNull();
  expect(await readFile(path)).toEqual(native.audio);
  const evidence = info.outputPath("actual-local-Deep-evidence.json");
  await writeFile(evidence, JSON.stringify({ source: applied.source, revision: applied.revision, compiledMoves: capture.compiledMoves, capturedFrames: 16384, maximumLiveError, exactNativeWavBytes: native.audio.length }, null, 2));
  await info.attach("actual-local-Deep-evidence", { path: evidence, contentType: "application/json" });
  await assertPrivate(info, requests);
});
