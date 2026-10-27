/* Test-owned Playwright download/artifact paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
// cspell:words spinbutton
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fixture, decode } from "../e2e/audio-fixture";
import { denseFixture } from "../e2e/workflow-fixture";
import { engineParams, exportParams, exportScript } from "../src/lib/engine-params";
import type { AdvancedParams, ExportDelivery, MeasuredAudioMetrics, Track } from "../src/lib/types";
import type { ReleaseReport } from "../src/lib/release-review";
import type { ScriptV2 } from "../src/lib/deep-mastering";
import { captureDeepDevice, capturedDevice, capturedProgress } from "../e2e/deep-capture";

function observeNetwork(context: BrowserContext) {
  const requests: { method: string; url: string; bodyBytes: number }[] = [];
  context.on("request", (request) => { requests.push({ method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0 }); });
  return requests;
}
async function upload(page: Page, source: Buffer, name: string) {
  await page.goto("/");
  await page.getByLabel("Import audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: source });
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
// Exports render with algorithm 2; live playback (live = true) stays on algorithm 1.
async function nativeRender(info: TestInfo, source: Buffer, advanced: AdvancedParams, bitDepth: number, script?: ScriptV2, live = false, delivery: ExportDelivery = {}) {
  const directory = info.outputPath(`native-oracle-${String(bitDepth)}${live ? "-live" : ""}${delivery.sampleRate ? `-${String(delivery.sampleRate)}` : ""}${delivery.dither ? `-${delivery.dither}` : ""}`);
  await mkdir(directory, { recursive: true });
  await writeFile(directory + "/source.wav", source);
  const rendered = script ? { script: JSON.stringify(live ? script : exportScript(script)) } : { params: JSON.stringify(live ? engineParams(advanced) : exportParams(advanced)) };
  await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", ...rendered, bitDepth, ...delivery }));
  execFileSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe" });
  return { audio: await readFile(directory + "/native.wav"), metadata: JSON.parse(await readFile(directory + "/native.json", "utf8")) as { sampleRate: number; frames: number; afterMetrics: { integratedLufs: number; samplePeakDbfs: number; truePeakDbtp: number } } };
}
async function downloadBytes(page: Page, name: string): Promise<Buffer> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const downloaded = await event, path = await downloaded.path();
  expect(await downloaded.failure()).toBeNull();
  if (!path) throw new Error("Missing retained local download");
  return readFile(path);
}
async function reviewEncoded(page: Page, info: TestInfo, expected: Buffer, label: string, scriptRevision: number | null = null) {
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download measured WAV", exact: true })).toBeEnabled({ timeout: 30_000 });
  const report = JSON.parse((await downloadBytes(page, "Download JSON report")).toString("utf8")) as ReleaseReport;
  expect(await downloadBytes(page, "Download measured WAV")).toEqual(expected);
  expect(await downloadBytes(page, "Download measured WAV")).toEqual(expected);
  const pcm = decode(expected);
  expect(report.output.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  expect(report.output).toMatchObject({ bytes: expected.length, bitDepth: pcm.bits, channels: 2, frames: pcm.left.length, sampleRate: pcm.rate });
  expect(report.scriptRevision).toBe(scriptRevision);
  expect(expected.length).toBe(44 + pcm.left.length * pcm.bits / 4);
  const directory = info.outputPath(`native-final-encoded-${label}`);
  await mkdir(directory, { recursive: true }); await writeFile(directory + "/source.wav", expected);
  await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", params: '{"bypass":true}', format: "json" }));
  execFileSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe" });
  const native = JSON.parse(await readFile(directory + "/native.json", "utf8")) as { sampleRate: number; frames: number; afterMetrics: MeasuredAudioMetrics };
  expect(native.sampleRate).toBe(pcm.rate); expect(native.frames).toBe(pcm.left.length);
  expect(Object.keys(report.metrics).sort()).toEqual(Object.keys(native.afterMetrics).sort());
  expect(Object.keys(report.metrics)).toHaveLength(11);
  let maximumDiagnosticError = 0;
  const nativeValues = new Map<string, unknown>(Object.entries(native.afterMetrics));
  const metricEntries: [string, unknown][] = Object.entries(report.metrics);
  for (const [key, actual] of metricEntries) {
    const target = nativeValues.get(key);
    if (typeof actual !== "number" || typeof target !== "number") throw new Error("Final diagnostic metric must be numeric");
    expect(Number.isFinite(actual) && Number.isFinite(target)).toBe(true);
    if (key === "clippingSamples") expect(actual).toBe(target);
    else { maximumDiagnosticError = Math.max(maximumDiagnosticError, Math.abs(actual - target)); expect(Math.abs(actual - target)).toBeLessThanOrEqual(1e-10); }
  }
  const evidence = info.outputPath(`encoded-review-${label}.json`);
  await writeFile(evidence, JSON.stringify({ report, exactRetainedWavBytes: expected.length, maximumDiagnosticError, nativeFinalMetrics: native.afterMetrics }, null, 2));
  await info.attach(`encoded-review-${label}`, { path: evidence, contentType: "application/json" });
  return report;
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
  // Saved masters survive a reload and download together as a stored ZIP.
  await page.reload();
  const zipping = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all as ZIP", exact: true }).click();
  const zipped = await zipping, zipPath = await zipped.path();
  if (!zipPath) throw new Error("Missing local album ZIP");
  expect(zipped.suggestedFilename()).toBe("Untitled sequence 1 - album masters.zip");
  const archive = await readFile(zipPath), name = "01 private album source.wav";
  expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  expect(archive.subarray(30, 30 + Buffer.byteLength(name)).toString("utf8")).toBe(name);
  expect(archive.subarray(30 + Buffer.byteLength(name), 30 + Buffer.byteLength(name) + rendered.length)).toEqual(rendered);
  await page.goto(`/release-check/${id}`);
  await reviewEncoded(page, info, rendered, "album-24");
  await assertPrivate(info, requests);
});


test("Release retains native-equivalent final 16/24/32-bit WAVs and exact encoded metrics with no upload", async ({ page, context }, info) => {
  const requests = observeNetwork(context);
  const source = fixture(997, 1), id = await upload(page, source, "private-encoded-source.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await expect.poll(async () => (await settings(page, id)).input).toBe(3);
  const advanced = await settings(page, id);
  await page.goto(`/release-check/${id}`);
  for (const bitDepth of [16, 24, 32]) {
    await page.getByRole("combobox", { name: "Review encoding", exact: true }).selectOption(String(bitDepth));
    const native = await nativeRender(info, source, advanced, bitDepth);
    await reviewEncoded(page, info, native.audio, String(bitDepth));
  }
  await assertPrivate(info, requests);
});

/** Native BS.1770 loudness and 4x true peak of a downloaded WAV, unprocessed. */
async function nativeLevel(info: TestInfo, wav: Buffer, label: string): Promise<MeasuredAudioMetrics> {
  const directory = info.outputPath(`native-meter-${label}`);
  await mkdir(directory, { recursive: true }); await writeFile(directory + "/source.wav", wav);
  await writeFile(directory + "/request.json", JSON.stringify({ operation: "render", params: '{"bypass":true}', format: "json" }));
  execFileSync("go", ["test", "./internal/browserjobs", "-run", "^TestWriteBrowserOracle$", "-count=1"], { env: { ...process.env, AURIALIS_BROWSER_ORACLE_DIR: directory }, stdio: "pipe" });
  return (JSON.parse(await readFile(directory + "/native.json", "utf8")) as { afterMetrics: MeasuredAudioMetrics }).afterMetrics;
}

// Streaming is the Pop default; Custom keeps the Loud −9 LUFS target under a
// −1.5 dBTP ceiling, seeded the way a saved custom/profile project carries it.
for (const { name, targetLufs, ceiling } of [{ name: "Streaming", targetLufs: -14, ceiling: -1 }, { name: "Custom", targetLufs: -9, ceiling: -1.5 }]) {
  test(`Set target loudness on a dense program converges in the browser worker and exports at ${String(targetLufs)} LUFS / ${String(ceiling)} dBTP`, async ({ page, context }, info) => {
    test.setTimeout(180_000);
    const requests = observeNetwork(context);
    const id = await upload(page, denseFixture(8), "private-dense-source.wav");
    await page.getByRole("tab", { name: "simple", exact: true }).click();
    await page.getByRole("button", { name: "Pop", exact: true }).click();
    await expect.poll(async () => (await settings(page, id)).limiter).toMatchObject({ enabled: true, targetLufs: -14, ceiling: -1 });
    if (name === "Custom") {
      await page.getByRole("combobox", { name: "Output target", exact: true }).selectOption("Loud");
      await expect.poll(async () => (await settings(page, id)).limiter.targetLufs).toBe(targetLufs);
      await page.evaluate(({ trackId, ceiling: next }) => {
        const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] };
        state.tracks = state.tracks.map((track) => track.id === trackId
          ? { ...track, mode: "simple", target: "Loud", simpleCustom: true, advanced: { ...track.advanced, limiter: { ...track.advanced.limiter, ceiling: next } } }
          : track);
        localStorage.setItem("aurialis-state-v1", JSON.stringify(state));
      }, { trackId: id, ceiling });
      await page.reload();
      await expect(page.getByRole("combobox", { name: "Output target", exact: true })).toHaveValue("custom", { timeout: 30_000 });
      await expect.poll(async () => (await settings(page, id)).limiter).toMatchObject({ enabled: true, targetLufs, ceiling });
    }
    const before = (await settings(page, id)).input;
    const apply = page.getByRole("button", { name: "Set target loudness", exact: true });
    await expect(apply).toBeEnabled({ timeout: 30_000 });
    await apply.click();
    await expect(page.getByText(/^Preview ready\. Export measures −\d+\.\d{2} LUFS, −\d+\.\d{2} dBTP\./u)).toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => (await settings(page, id)).input).not.toBe(before);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: "24-bit PCM", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    const path = await (await downloading).path();
    if (!path) throw new Error("Missing browser-local dense export");
    const afterMetrics = await nativeLevel(info, await readFile(path), `dense-${name}`);
    await info.attach(`dense-browser-export-${name}`, { body: JSON.stringify({ input: (await settings(page, id)).input, afterMetrics }, null, 2), contentType: "application/json" });
    expect(Math.abs(afterMetrics.integratedLufs - targetLufs)).toBeLessThanOrEqual(0.2);
    expect(afterMetrics.truePeakDbtp).toBeLessThanOrEqual(ceiling);
    await assertPrivate(info, requests);
  });
}

// Album normalization runs the same export-parameter search per track in the
// worker. Dense programs at different levels all need limiting to reach −14.
test("a dense 3-track album renders every browser-local master at −14 LUFS within the −1 dBTP ceiling", async ({ page, context }, info) => {
  test.setTimeout(300_000);
  const requests = observeNetwork(context);
  const tracks = [{ title: "private dense album 1", peak: -1.3 }, { title: "private dense album 2", peak: -4 }, { title: "private dense album 3", peak: -8 }];
  for (const track of tracks) {
    await upload(page, denseFixture(6, track.peak), `${track.title.replaceAll(" ", "-")}.wav`);
    await page.getByRole("tab", { name: "simple", exact: true }).click();
    await page.getByRole("button", { name: "Pop", exact: true }).click();
  }
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  for (const track of tracks) await page.getByRole("button", { name: track.title, exact: true }).click();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const levels: MeasuredAudioMetrics[] = [];
  for (const [index, track] of tracks.entries()) {
    const ready = page.getByRole("button", { name: `Download ${track.title}`, exact: true });
    await expect(ready).toBeVisible({ timeout: 240_000 });
    const downloading = page.waitForEvent("download");
    await ready.click();
    const path = await (await downloading).path();
    if (!path) throw new Error("Missing browser-local album master");
    const wav = await readFile(path);
    expect(decode(wav).bits).toBe(24);
    levels.push(await nativeLevel(info, wav, `album-${String(index + 1)}`));
  }
  await info.attach("dense-browser-album-levels", { body: JSON.stringify(levels, null, 2), contentType: "application/json" });
  for (const level of levels) {
    expect(Math.abs(level.integratedLufs + 14)).toBeLessThanOrEqual(0.2);
    expect(level.truePeakDbtp).toBeLessThanOrEqual(-1);
  }
  await assertPrivate(info, requests);
});

test("a 44.1 kHz undithered export from a 48 kHz source matches the native converted render byte for byte", async ({ page, context }, info) => {
  const requests = observeNetwork(context);
  const source = fixture(997, 2), id = await upload(page, source, "private-converted-source.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await expect.poll(async () => (await settings(page, id)).input).toBe(3);
  const advanced = await settings(page, id);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: "16-bit PCM", exact: true }).click();
  const rates = dialog.getByRole("group", { name: "Sample rate", exact: true });
  await expect(rates.getByRole("button")).toHaveText(["44.1 kHz", "48 kHz (source)", "88.2 kHz", "96 kHz"]);
  await rates.getByRole("button", { name: "44.1 kHz", exact: true }).click();
  await dialog.getByRole("group", { name: "Dither", exact: true }).getByRole("button", { name: "Off", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const downloaded = await downloading, path = await downloaded.path();
  if (!path) throw new Error("Missing browser-local converted export");
  expect(await downloaded.failure()).toBeNull();
  expect(downloaded.suggestedFilename()).toMatch(/-44\.1k-16bit\.wav$/u);
  const native = await nativeRender(info, source, advanced, 16, undefined, false, { sampleRate: 44100, dither: "none" });
  expect(native.metadata.sampleRate).toBe(44100);
  expect(native.metadata.frames).toBe(88200);
  const exported = await readFile(path);
  expect(exported).toEqual(native.audio);
  const pcm = decode(exported);
  expect([pcm.rate, pcm.bits, pcm.left.length]).toEqual([44100, 16, 88200]);
  await expect(dialog.getByRole("status")).toContainText(`Delivered true peak ${native.metadata.afterMetrics.truePeakDbtp.toFixed(2)} dBTP at 44.1 kHz.`);
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
  const pcm = decode((await nativeRender(info, source, accepted.advanced, 32, applied, true)).audio);
  let maximumLiveError = 0;
  for (let frame = 0; frame < 16384; frame++) {
    maximumLiveError = Math.max(maximumLiveError, Math.abs((pcm.left.at(frame) ?? Infinity) - (capture.outputLeft.at(frame) ?? 0)), Math.abs((pcm.right.at(frame) ?? Infinity) - (capture.outputRight.at(frame) ?? 0)));
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
  const native = await nativeRender(info, source, accepted.advanced, 32, applied);
  expect(await readFile(path)).toEqual(native.audio);
  const evidence = info.outputPath("actual-local-Deep-evidence.json");
  await writeFile(evidence, JSON.stringify({ source: applied.source, revision: applied.revision, compiledMoves: capture.compiledMoves, capturedFrames: 16384, maximumLiveError, exactNativeWavBytes: native.audio.length }, null, 2));
  await info.attach("actual-local-Deep-evidence", { path: evidence, contentType: "application/json" });
  await page.goto(`/release-check/${id}`);
  const encoded = await nativeRender(info, source, accepted.advanced, 24, applied);
  const reviewed = await reviewEncoded(page, info, encoded.audio, "Deep-24", applied.revision);
  expect(reviewed.source).toEqual(applied.source);
  await assertPrivate(info, requests);
});
