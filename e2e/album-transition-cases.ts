import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";

async function download(page: Page, name: string): Promise<Buffer> {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  return readFile(await (await waiting).path());
}
async function build(page: Page): Promise<Buffer> {
  await page.getByRole("button", { name: "Build continuous WAV", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download continuous WAV", exact: true })).toBeVisible({ timeout: 60_000 });
  const audio = page.getByLabel("Continuous album preview", { exact: true });
  await expect(audio).toHaveAttribute("preload", "none");
  expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  return download(page, "Download continuous WAV");
}

export function registerAlbumTransitionCase(execution: "native" | "browser") {
test("continuous album preserves masters, inserts silence, mixes linear edges and cancels pending work", async ({ page, context }, info) => {
  const requests: { method: string; url: string; bytes: number }[] = [];
  if (execution === "browser") context.on("request", (request) => { requests.push({ method: request.method(), url: request.url(), bytes: request.postDataBuffer()?.length ?? 0 }); });
  test.setTimeout(180_000);
  const firstId = await uploadProject(page, "sequence-first.wav", 1, fixture(330, 1));
  await uploadProject(page, "sequence-second.wav", 1, fixture(550, 1));
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/ }).click();
  const albumUrl = page.url();
  await page.getByRole("button", { name: "sequence first", exact: true }).click();
  await page.getByRole("button", { name: "sequence second", exact: true }).click();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download sequence second", exact: true })).toBeVisible({ timeout: 60_000 });
  const first = await download(page, "Download sequence first"), second = await download(page, "Download sequence second");
  const gapless = await build(page);
  expect(gapless.subarray(44).equals(Buffer.concat([first.subarray(44), second.subarray(44)]))).toBe(true);
  const one = decode(first), two = decode(second);
  expect(decode(gapless).left).toHaveLength(one.left.length + two.left.length);

  const transitions = page.getByRole("region", { name: "Album transitions", exact: true });
  await transitions.getByRole("button", { name: "Silence between tracks", exact: true }).click();
  await page.getByRole("slider", { name: "Gap duration", exact: true }).fill("0.2");
  await expect(page.getByRole("button", { name: "Download continuous WAV", exact: true })).toHaveCount(0);
  const gap = await build(page), align = first.readUInt16LE(32), frames = Math.round(one.rate * 0.2);
  expect(gap.subarray(44).equals(Buffer.concat([first.subarray(44), Buffer.alloc(frames * align), second.subarray(44)]))).toBe(true);

  await transitions.getByRole("button", { name: "Linear crossfade", exact: true }).click();
  await page.getByRole("slider", { name: "Crossfade duration", exact: true }).fill("0.2");
  const crossfade = await build(page), result = decode(crossfade), start = one.left.length - frames;
  expect(result.left).toHaveLength(one.left.length + two.left.length - frames);
  expect(crossfade.subarray(44, 44 + start * align).equals(first.subarray(44, 44 + start * align))).toBe(true);
  expect(crossfade.subarray(44 + one.left.length * align).equals(second.subarray(44 + frames * align))).toBe(true);
  const tolerance = 2 / 2 ** (one.bits - 1);
  for (const index of [0, Math.floor(frames / 2), frames - 1]) {
    const mix = index / (frames - 1);
    for (const channel of ["left", "right"] as const) {
      const expected = (one[channel][start + index] ?? 0) * (1 - mix) + (two[channel][index] ?? 0) * mix;
      expect(Math.abs((result[channel][start + index] ?? 0) - expected)).toBeLessThanOrEqual(tolerance);
    }
  }
  expect((await download(page, "Download sequence first")).equals(first)).toBe(true);
  expect((await download(page, "Download sequence second")).equals(second)).toBe(true);

  await page.getByRole("button", { name: "Discard continuous WAV", exact: true }).click();
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("**/offline-job-worker.js", async (route) => { entered?.(); await blocked; await route.continue(); });
  try {
    await page.getByRole("button", { name: "Build continuous WAV", exact: true }).click();
    await started;
    await page.getByRole("button", { name: "Cancel continuous album", exact: true }).click();
    await expect(page.getByRole("button", { name: "Build continuous WAV", exact: true })).toBeEnabled();
    await expect(transitions.getByRole("status")).toContainText("cancelled");
    await expect(page.getByRole("button", { name: "Download continuous WAV", exact: true })).toHaveCount(0);
  } finally { release?.(); await page.unrouteAll({ behavior: "wait" }); }

  // Start with real retained Classic masters and a playable continuous result.
  // A changed project quality must invalidate both ways of reusing those files.
  await build(page);
  await page.goto(`/master/${firstId}`);
  await page.getByRole("button", { name: "Oversampled", exact: true }).click();
  await expect(page.getByRole("button", { name: "Oversampled", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto(albumUrl);
  await expect(page.getByText(/Saved masters no longer match this sequence or its settings/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download sequence first", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download sequence second", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download continuous WAV", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Build continuous WAV", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download sequence second", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Download sequence first", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Build continuous WAV", exact: true })).toBeEnabled();
  const refreshed = decode(await build(page));
  expect(refreshed.rate).toBe(one.rate);
  expect(refreshed.left).toHaveLength(one.left.length + two.left.length - frames);
  if (execution === "browser") {
    expect(requests.filter((request) => !["GET", "HEAD"].includes(request.method) || request.bytes > 0)).toEqual([]);
    const origin = new URL(page.url()).origin;
    expect(requests.every((request) => new URL(request.url).origin === origin)).toBe(true);
    await info.attach("private-album-quality-network", { body: JSON.stringify(requests), contentType: "application/json" });
  }
});
}
