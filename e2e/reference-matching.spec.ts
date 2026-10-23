import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { decode } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";
import { meanRenderOutput, observeRenderOutput } from "./render-output";
import type { AdvancedParams } from "../src/lib/types";

/** Independent physical-band tones; no application EQ is used to make the reference. */
function multitone(reference = false, seconds = 4): Buffer {
  const frames = 48000 * seconds, wav = Buffer.alloc(44 + frames * 8);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(384000, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write("data", 36); wav.writeUInt32LE(frames * 8, 40);
  const frequencies = [60, 250, 997, 2800, 9000], levels = reference ? [.022, .027, .03, .038, .046] : [.03, .03, .03, .03, .03];
  for (let frame = 0; frame < frames; frame++) {
    const mid = frequencies.reduce((value, frequency, i) => value + (levels.at(i) ?? 0) * Math.sin(2 * Math.PI * frequency * frame / 48000), 0);
    const side = (reference ? .02 : .01) * Math.sin(2 * Math.PI * 3001 * frame / 48000);
    wav.writeFloatLE(mid + side, 44 + frame * 8); wav.writeFloatLE(mid - side, 48 + frame * 8);
  }
  return wav;
}
async function upload(page: Page, file: Buffer, name: string) {
  await page.goto("/"); await page.getByLabel("Upload audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: file });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  return new URL(page.url()).pathname.split("/")[2] ?? "";
}
async function setup(page: Page, seconds = 4) {
  const source = multitone(false, seconds), sourceId = await upload(page, source, "qa-measured-source.wav"), referenceId = await upload(page, multitone(true, seconds), "qa-measured-reference.wav");
  await page.goto(`/reference/${sourceId}`); await page.getByRole("combobox", { name: "Reference track", exact: true }).selectOption(referenceId);
  return { source, sourceId };
}
async function settings(page: Page, id: string) {
  return page.evaluate((id) => {
    const saved = localStorage.getItem("aurialis-state-v1"); if (!saved) throw new Error("Missing saved source");
    const track = (JSON.parse(saved) as { tracks: { id: string; advanced: AdvancedParams }[] }).tracks.find((item) => item.id === id); if (!track) throw new Error("Missing source project"); return track.advanced;
  }, id);
}

/** Delay delivery after the real node connects, preserving actual WASI processing. */
async function delayReady(page: Page) {
  await page.addInitScript(() => {
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "aurialis-live") return;
        const port = this.port;
        let handler: ((event: MessageEvent<unknown>) => void) | null = null;
        Object.defineProperty(port, "onmessage", { configurable: true, get: () => handler, set: (next: typeof handler) => { handler = next; } });
        port.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: string };
          if (data.type === "ready") setTimeout(() => { handler?.call(port, event); }, 1500);
          else handler?.call(port, event);
        });
        port.start();
      }
    };
  });
}

test("measured Reference changes real live and downloaded PCM from one immutable baseline", async ({ page, request }, info) => {
  test.setTimeout(120_000); await observeOutput(page); await observeRenderOutput(page); await delayReady(page);
  const { source, sourceId } = await setup(page), before = await settings(page, sourceId);
  const measured = page.waitForResponse(async (response) => {
    if (!response.url().includes("/api/jobs/") || response.request().method() !== "GET") return false;
    const body: unknown = await response.json(); return typeof body === "object" && body !== null && "status" in body && body.status === "done" && "referenceProposal" in body;
  });
  await page.getByRole("button", { name: "Analyze reference audio", exact: true }).click();
  const job = await (await measured).json() as { referenceProposal: { params: unknown; beforeOutputResidualDb: number; afterOutputResidualDb: number; beforeResidualDb: number; fitResidualDb: number; maxProtectedDeltaDb: number; remeasuredProtectedDeltaDb: number } };
  await expect(page.getByRole("button", { name: "Apply measured proposal", exact: true })).toBeEnabled();
  expect(await settings(page, sourceId), "analysis must not change settings").toEqual(before);
  expect(job.referenceProposal.fitResidualDb).toBeLessThan(job.referenceProposal.beforeResidualDb);
  expect(job.referenceProposal.afterOutputResidualDb).toBeLessThan(job.referenceProposal.beforeOutputResidualDb);
  await expect(page.getByText(`Rendered spectral mismatch: ${job.referenceProposal.beforeOutputResidualDb.toFixed(2)} → ${job.referenceProposal.afterOutputResidualDb.toFixed(2)} dB`, { exact: false })).toBeVisible();
  expect(job.referenceProposal.maxProtectedDeltaDb).toBeLessThanOrEqual(.25);
  expect(Math.abs(job.referenceProposal.remeasuredProtectedDeltaDb)).toBeLessThanOrEqual(.25);
  await page.getByRole("button", { name: "Apply measured proposal", exact: true }).click();
  await expect(page.getByText(/Measured proposal applied/u)).toBeVisible();
  const applied = await settings(page, sourceId);
  expect(applied.eqBands.some((band, i) => band.gainDb !== before.eqBands.at(i)?.gainDb)).toBe(true);
  expect(applied.stereo).toEqual(before.stereo);
  await page.getByRole("button", { name: "Apply measured proposal", exact: true }).click(); expect(await settings(page, sourceId)).toEqual(applied);
  await page.getByRole("link", { name: "Back to master", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const downloading = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click(); const path = await (await downloading).path(); if (!path) throw new Error("Missing actual exported Reference PCM");
  const downloaded = decode(await readFile(path)); await page.keyboard.press("Escape");
  const native = await request.post("/api/master/render", { multipart: { file: { name: "source.wav", mimeType: "audio/wav", buffer: source }, params: JSON.stringify(job.referenceProposal.params), bitDepth: "32" } });
  expect(native.ok()).toBe(true); const expected = decode(await native.body());
  expect(downloaded.left).toEqual(expected.left); expect(downloaded.right).toEqual(expected.right); expect(downloaded.left.length).toBe(48000 * 4);
  const original = decode(source); expect(downloaded.left.some((sample, i) => Math.abs(sample - (original.left.at(i) ?? 0)) > .001)).toBe(true);
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await page.getByRole("button", { name: "Repeat track", exact: true }).click(); await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(48000);
  const callbackLevel = await meanOutputLevel(page);
  const live = await meanRenderOutput(page);
  const callbackWindows = [callbackLevel, await meanOutputLevel(page), await meanOutputLevel(page)];
  const callbackMedian = [...callbackWindows].sort((left, right) => left - right)[1];
  const expectedDb = 10 * Math.log10((expected.left.reduce((sum, sample) => sum + sample * sample, 0) + expected.right.reduce((sum, sample) => sum + sample * sample, 0)) / (expected.left.length * 2));
  await info.attach("reference-rms-window", { body: JSON.stringify({ live, callbackWindows, callbackMedian, expectedDb, output: await outputLevel(page) }), contentType: "application/json" });
  expect(Math.abs(live - expectedDb), "timestamped worklet output energy must match the independently rendered proposal").toBeLessThan(.05);
  expect(callbackMedian).toBeDefined();
  expect(Math.abs((callbackMedian ?? Infinity) - expectedDb), "fixed three-window speaker-feed median must match native output").toBeLessThan(.05);
  await info.attach("measured-reference-output", { body: JSON.stringify({ before: before.eqBands, applied: applied.eqBands, liveDbfs: live, nativeDbfs: expectedDb, ...job.referenceProposal }, null, 2), contentType: "application/json" });
});

test("populated Reference review supports keyboard, 44px controls and WCAG2.2AA at six widths", async ({ page }, info) => {
  test.setTimeout(120_000); const { sourceId } = await setup(page, 1);
  await page.getByRole("checkbox", { name: "Include width", exact: true }).check();
  await page.getByRole("button", { name: "Analyze reference audio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply measured proposal", exact: true })).toBeEnabled();
  await expect(page.getByText(/Rendered correlation/u)).toBeVisible();
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `Reference overflow at${width}`).toBe(true);
    for (const control of await page.locator('.reference-layout button, .reference-layout input[type="range"], .reference-layout select, .reference-layout label.check-row').all()) {
      if (!(await control.isVisible())) continue; const box = await control.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    if (width === 320 || width === 1440) await info.attach(`reference-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  const before = await settings(page, sourceId); await page.getByRole("slider", { name: "Match amount", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Apply measured proposal", exact: true })).toBeDisabled(); expect(await settings(page, sourceId)).toEqual(before);
});
