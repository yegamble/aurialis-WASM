import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { denseFixture, uploadProject } from "./workflow-fixture";
import type { AdvancedParams } from "../src/lib/types";

async function previewPCM(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download offline preview", exact: true }).click();
  const download = await waiting;
  const path = await download.path();
  if (!path) throw new Error("Missing offline preview download");
  return decode(await readFile(path));
}
async function exportPCM(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await waiting;
  const path = await download.path();
  if (!path) throw new Error("Missing download");
  const pcm = decode(await readFile(path));
  await page.keyboard.press("Escape");
  return pcm;
}

test("EQ handles support keyboard and dragging without changing other bands or modules", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await uploadProject(page);
  const settings = () => page.evaluate((id) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing project settings");
    const track = (JSON.parse(raw) as { tracks: { id: string; advanced: AdvancedParams }[] }).tracks.find((track) => track.id === id);
    if (!track) throw new Error("Missing uploaded project");
    return track.advanced;
  }, id);
  const before = await settings();
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  const handle = page.getByRole("button", { name: /^Mid EQ:/ });
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  const keyboard = await settings();
  expect(keyboard.eqBands[2].gainDb).toBe(before.eqBands[2].gainDb + 0.5);
  expect(keyboard.eqBands[2].freqHz).toBeGreaterThan(before.eqBands[2].freqHz);
  const box = await handle.boundingBox();
  if (!box) throw new Error("Missing EQ touch target");
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 - 15, { steps: 5 });
  await page.mouse.up();
  const dragged = await settings();
  expect(dragged.eqBands[2].gainDb).not.toBe(keyboard.eqBands[2].gainDb);
  for (const actual of [keyboard, dragged]) {
    for (const index of [0, 1, 3, 4]) expect(actual.eqBands[index]).toEqual(before.eqBands[index]);
    expect({ ...actual, eqBands: before.eqBands }).toEqual(before);
  }
});

test("first Simple apply previews exactly the settings exported from the uploaded source", async ({ page }) => {
  test.setTimeout(120_000);
  await uploadProject(page);
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Set target loudness", exact: true }).click();
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("Offline preview matches your settings. It and live meters use the preview limiter, so peaks can read higher than the export. Live playback updates independently.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download offline preview", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export", exact: true }), "current canonical settings remain exportable after a Simple change").toBeEnabled();
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Set target loudness", exact: true }).click();
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("Offline preview matches your settings. It and live meters use the preview limiter, so peaks can read higher than the export. Live playback updates independently.", { exact: true })).toBeVisible();
  const preview = await previewPCM(page);
  const exported = await exportPCM(page);
  expect(preview.left).toHaveLength(exported.left.length);
  for (const channel of ["left", "right"] as const) {
    expect(Math.max(...preview[channel].map((sample, index) => Math.abs(sample - (exported[channel][index] ?? Infinity))))).toBeLessThan(1e-5);
  }
});

test("re-applying an unchanged Simple direction never compounds EQ or other settings", async ({ page }) => {
  test.setTimeout(120_000);
  await uploadProject(page);
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Rock", exact: true }).click();
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  const snapshots: unknown[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const apply = page.getByRole("button", { name: "Set target loudness", exact: true });
    await apply.click();
    await expect(apply).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
    snapshots.push(await page.evaluate(() => {
      const raw = localStorage.getItem("aurialis-state-v1");
      if (!raw) throw new Error("Missing project settings");
      return (JSON.parse(raw) as { tracks: { advanced: unknown }[] }).tracks[0]?.advanced;
    }));
  }
  expect(snapshots[0]).toBeDefined();
  expect(snapshots[1]).toEqual(snapshots[0]);
  expect(snapshots[2]).toEqual(snapshots[0]);
});

test("measured reference ignores saved reference knobs and keeps width opt-in", async ({ page }) => {
  const sourceId = await uploadProject(page, "qa-source.wav");
  const referenceId = await uploadProject(page, "qa-reference.wav");
  await page.getByRole("slider", { name: "Stereo width", exact: true }).fill("140");
  await page.getByRole("tab", { name: "Sub", exact: true }).click();
  await page.getByRole("slider", { name: "Sub gain", exact: true }).fill("6");
  await page.getByRole("tab", { name: "Presence", exact: true }).click();
  await page.getByRole("slider", { name: "Presence gain", exact: true }).fill("4");
  await page.goto(`/reference/${sourceId}`);
  await page.getByRole("combobox", { name: "Reference track", exact: true }).selectOption(referenceId);
  await expect(page.getByRole("checkbox", { name: "Include width", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Analyze reference audio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply measured proposal", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply measured proposal", exact: true }).click();
  await expect(page.getByText(/Measured proposal applied/u)).toBeVisible();
  await page.getByRole("link", { name: "Back to master", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Stereo width", exact: true })).toHaveValue("100");
  await page.getByRole("tab", { name: "Sub", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Sub gain", exact: true })).toHaveValue("0");
  await page.getByRole("tab", { name: "Presence", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Presence gain", exact: true })).toHaveValue("0");
});

test("album processing produces real full-length WAVs and release checks measure rendered audio", async ({ page, request }) => {
  const id = await uploadProject(page, "qa-album-source.wav");
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/ }).click();
  await page.getByRole("button", { name: "qa album source", exact: true }).click();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const downloadButton = page.getByRole("button", { name: "Download qa album source", exact: true });
  await expect(downloadButton).toBeVisible();
  const waiting = page.waitForEvent("download");
  await downloadButton.click();
  const download = await waiting;
  const path = await download.path();
  if (!path) throw new Error("Missing album WAV");
  const pcm = decode(await readFile(path));
  expect(pcm.bits).toBe(24);
  expect(pcm.left).toHaveLength(48000);
  expect(pcm.left.some((value) => Math.abs(value) > 0.01)).toBe(true);
  await page.goto(`/release-check/${id}`);
  const pendingMeasurement = page.waitForResponse((response) => response.url().endsWith("/api/master/render") && response.request().method() === "POST" && response.headers()["content-type"]?.startsWith("application/json") === true);
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  const measurement = await (await pendingMeasurement).json() as { afterMetrics: { integratedLufs: number; samplePeakDbfs: number } };
  await expect(page.getByText(`${measurement.afterMetrics.integratedLufs.toFixed(1)} LUFS`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Sample peak ${measurement.afterMetrics.samplePeakDbfs.toFixed(2)} dBFS.`, { exact: false })).toBeVisible();
  await expect(page.getByText("Unmeasured", { exact: false })).toHaveCount(0);
  expect((await request.get("/health")).ok()).toBe(true);
});

type MeasuredLevel = { integratedLufs: number; truePeakDbtp: number };
async function measureWAV(request: APIRequestContext, buffer: Buffer): Promise<MeasuredLevel> {
  const response = await request.post("/api/master/render", { multipart: { file: { name: "measure.wav", mimeType: "audio/wav", buffer }, params: JSON.stringify({ bypass: true }), format: "json" } });
  expect(response.status()).toBe(200);
  return (await response.json() as { beforeMetrics: MeasuredLevel }).beforeMetrics;
}

async function exportWAV(page: Page): Promise<Buffer> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const path = await (await waiting).path();
  await page.keyboard.press("Escape");
  return readFile(path);
}
async function savedProjects(page: Page, ids: string[]) {
  return page.evaluate((ids) => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { id: string; advanced: AdvancedParams; measurementKind?: string; measurements?: unknown }[] };
    return ids.map((id) => {
      const track = state.tracks.find((item) => item.id === id);
      if (!track) throw new Error("Missing album project");
      return { advanced: track.advanced, measurementKind: track.measurementKind, measurements: track.measurements };
    });
  }, ids);
}
const signed = (value: number, digits: number) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;
async function renderAlbum(page: Page, request: APIRequestContext, titles: string[]): Promise<MeasuredLevel[]> {
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const levels: MeasuredLevel[] = [];
  for (const title of titles) {
    const button = page.getByRole("button", { name: `Download ${title}`, exact: true });
    await expect(button).toBeVisible({ timeout: 180_000 });
    const waiting = page.waitForEvent("download");
    await button.click();
    const wav = await readFile(await (await waiting).path());
    expect(decode(wav).bits).toBe(24);
    levels.push(await measureWAV(request, wav));
  }
  // The chart reports what the app measured from the same rendered files.
  const table = page.getByRole("table", { name: "Measured album masters" });
  for (const level of levels) await expect(table).toContainText(`${signed(level.integratedLufs, 2)} LUFS`);
  return levels;
}

async function exportAt(page: Page, rate: RegExp, bits: string): Promise<Buffer> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: bits, exact: true }).click();
  await dialog.getByRole("group", { name: "Sample rate", exact: true }).getByRole("button", { name: rate }).click();
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const path = await (await waiting).path();
  await page.keyboard.press("Escape");
  return readFile(path);
}

// V1-04: one album delivery format makes a mixed-rate album uniform, and a kept
// master is the single export at that format.
test("a mixed 48 kHz / 44.1 kHz album renders every master at 44.1 kHz/16-bit, each equal to its single export", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const tracks = [{ title: "qa mixed album 48k", source: fixture(1000, 1) }, { title: "qa mixed album 44k", source: fixture(997, 1, 44100) }];
  const singles: Buffer[] = [];
  for (const track of tracks) {
    await uploadProject(page, `${track.title.replaceAll(" ", "-")}.wav`, 1, track.source);
    await page.getByRole("slider", { name: "Input gain", exact: true }).fill("2");
    singles.push(await exportAt(page, /^44\.1 kHz/u, "16-bit PCM"));
  }
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/ }).click();
  for (const track of tracks) await page.getByRole("button", { name: track.title, exact: true }).click();
  const panel = page.getByRole("region", { name: "Album delivery format", exact: true });
  await expect(panel.getByText("These sources use 44.1 kHz and 48 kHz. Choose one sample rate for a uniform album.", { exact: true })).toBeVisible();
  // Mixed source rates offer one tap to Red Book CD PCM.
  await panel.getByRole("button", { name: "Use CD format: 44.1 kHz, 16-bit", exact: true }).click();
  await expect(panel.getByRole("group", { name: "Sample rate", exact: true }).getByRole("button", { name: "44.1 kHz", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: "16-bit PCM", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".album-meta")).toContainText("44.1 kHz · 16-bit PCM · TPDF dither");
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const evidence: { title: string; rate: number; bits: number; frames: number; albumLufs: number; singleLufs: number; identical: boolean }[] = [];
  for (const [index, track] of tracks.entries()) {
    const button = page.getByRole("button", { name: `Download ${track.title}`, exact: true });
    await expect(button).toBeVisible({ timeout: 120_000 });
    const waiting = page.waitForEvent("download");
    await button.click();
    const wav = await readFile(await (await waiting).path()), single = singles.at(index) ?? Buffer.alloc(0);
    const pcm = decode(wav);
    expect([wav.readUInt32LE(24), wav.readUInt16LE(34), pcm.rate, pcm.bits, pcm.left.length]).toEqual([44100, 16, 44100, 16, 44100]);
    const [album, alone] = [await measureWAV(request, wav), await measureWAV(request, single)];
    evidence.push({ title: track.title, rate: pcm.rate, bits: pcm.bits, frames: pcm.left.length, albumLufs: album.integratedLufs, singleLufs: alone.integratedLufs, identical: wav.equals(single) });
    expect(Math.abs(album.integratedLufs - alone.integratedLufs)).toBeLessThanOrEqual(0.1);
    expect(wav.equals(single)).toBe(true);
  }
  await info.attach("mixed-rate-album", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

// Albums never write into projects. Keep (the default) renders every master at
// its own single-export level; normalize renders the displayed target plus each
// track's album offset. Dense programs at different levels need limiting.
test("a dense 3-track album keeps each export level, normalizes to target plus offset and never changes a project", async ({ page, request }, info) => {
  test.setTimeout(420_000);
  const tracks = [{ title: "qa dense album 1", peak: -1.3 }, { title: "qa dense album 2", peak: -4 }, { title: "qa dense album 3", peak: -8 }];
  const ids: string[] = [], singles: MeasuredLevel[] = [];
  for (const track of tracks) {
    ids.push(await uploadProject(page, `${track.title.replaceAll(" ", "-")}.wav`, 6, denseFixture(6, track.peak)));
    // A Simple direction enables the limiter at the Streaming −1 dBTP ceiling.
    await page.getByRole("tab", { name: "simple", exact: true }).click();
    await page.getByRole("button", { name: "Pop", exact: true }).click();
    singles.push(await measureWAV(request, await exportWAV(page)));
  }
  const before = await savedProjects(page, ids);
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/ }).click();
  for (const track of tracks) await page.getByRole("button", { name: track.title, exact: true }).click();
  await expect(page.locator(".album-meta")).toContainText("Keeps each master’s level");
  const kept = await renderAlbum(page, request, tracks.map((track) => track.title));
  expect(await savedProjects(page, ids)).toEqual(before);

  await page.getByRole("button", { name: "Normalize to a target", exact: true }).click();
  await page.getByRole("button", { name: "−16 LUFS", exact: true }).click();
  await page.getByRole("slider", { name: "qa dense album 2 album offset", exact: true }).fill("-2");
  await expect(page.locator(".album-meta")).toContainText("Normalizes to −16 LUFS");
  await expect(page.getByText("Renders at −18 LUFS", { exact: true })).toBeVisible();
  const requested = [-16, -18, -16];
  const normalized = await renderAlbum(page, request, tracks.map((track) => track.title));
  await expect(page.locator(".album-meta")).toContainText("Normalizes to −16 LUFS");
  expect(await savedProjects(page, ids)).toEqual(before);
  await info.attach("dense-album-levels", { body: JSON.stringify({ singles, kept, normalized, requested }, null, 2), contentType: "application/json" });
  for (const [index, level] of kept.entries()) expect(Math.abs(level.integratedLufs - (singles.at(index)?.integratedLufs ?? Number.NaN))).toBeLessThanOrEqual(0.1);
  for (const [index, level] of normalized.entries()) {
    expect(Math.abs(level.integratedLufs - (requested.at(index) ?? Number.NaN))).toBeLessThanOrEqual(0.2);
    expect(level.truePeakDbtp).toBeLessThanOrEqual(-1);
  }
});

test("each visible audio slider changes its own settings without mutating another module", async ({ page }) => {
  await uploadProject(page);
  const settings = async () => page.evaluate(() => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing persisted project settings");
    return (JSON.parse(raw) as { tracks: { advanced: Record<string, unknown> }[] }).tracks[0]?.advanced;
  });
  const cases = [
    { label: "Input gain", value: "3", changed: ["input"] },
    { label: "Threshold", value: "-24", changed: ["threshold", "compressor"] },
    { label: "Ratio", value: "4", changed: ["ratio", "compressor"] },
    { label: "Attack", value: "40", changed: ["attack", "compressor"] },
    { label: "Release", value: "180", changed: ["release", "compressor"] },
    { label: "Stereo width", value: "125", changed: ["width", "stereo"] },
    { label: "Saturation", value: "20", changed: ["saturation", "saturationModule"] },
    { label: "Limiter ceiling", value: "-2", changed: ["limiter"] },
  ];
  for (const item of cases) {
    const before = await settings();
    const slider = page.getByRole("slider", { name: item.label, exact: true });
    await slider.fill(item.value);
    await expect(slider).toHaveValue(item.value);
    const after = await settings();
    if (!before || !after) throw new Error("Missing advanced settings");
    expect(after, `${item.label} must change the project`).not.toEqual(before);
    for (const key of Object.keys(before).filter((key) => !item.changed.includes(key))) {
      expect(after[key], `${item.label} changed unrelated ${key}`).toEqual(before[key]);
    }
  }
  for (const band of ["Sub", "Low", "Mid", "Presence", "Air"]) {
    await page.getByRole("tab", { name: band, exact: true }).click();
    for (const [field, value] of [["gain", "3"], ["frequency", "1500"], ["Q", "2"]]) {
      const before = await settings();
      if (!before) throw new Error("Missing baseline EQ settings");
      const slider = page.getByRole("slider", { name: `${band} ${field}`, exact: true });
      await slider.fill(value!);
      const after = await settings();
      if (!after) throw new Error("Missing updated EQ settings");
      for (const key of Object.keys(before).filter((key) => key !== "eqBands")) expect(after[key]).toEqual(before[key]);
      const oldBands = before.eqBands as { label: string }[];
      const newBands = after.eqBands as { label: string }[];
      for (let index = 0; index < oldBands.length; index++) {
        if (oldBands[index]?.label !== band) expect(newBands[index], `${band} ${field} changed another band`).toEqual(oldBands[index]);
      }
    }
  }
});
