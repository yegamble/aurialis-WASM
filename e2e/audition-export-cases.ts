/* Test-owned Playwright download paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { denseFixture, uploadProject } from "./workflow-fixture";

// V1-10 owner ruling: a source above 48 kHz plays live at a capped rate, so
// Audition export plays the exact file Export writes, from its Blob. Shared by
// the native and browser-build suites.
const SECONDS = 4, RATE = 96000;
type AuditionWindow = Window & { qaDecodes?: number };

/** Count every decodeAudioData call, so a second decoded copy of the audition would show. */
async function countDecodes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as AuditionWindow;
    scope.qaDecodes = 0;
    const native = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, ...args: Parameters<typeof native>) {
      scope.qaDecodes = (scope.qaDecodes ?? 0) + 1;
      return Reflect.apply(native, this, args) as ReturnType<typeof native>;
    };
  });
}

/** The audition element's position while it is playing, else 0. */
export function playingAt(page: Page) {
  return page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>("audio.audition-export");
    return audio && !audio.paused ? audio.currentTime : 0;
  });
}

export async function upload96(page: Page): Promise<void> {
  await uploadProject(page, "audition-96k.wav", SECONDS, denseFixture(SECONDS, -1.3, RATE));
  await expect(page.getByText(/^Aurialis plays this 96 kHz source live at 48 kHz/u)).toBeVisible();
}

/** Audition export plays, and its Blob is byte-identical to the Export download. */
export async function verifyAuditionMatchesExport(page: Page): Promise<{ digest: string; size: number }> {
  await countDecodes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
  await expect(page.getByText("Playing the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).", { exact: true })).toBeVisible();
  const audition = await page.evaluate(async () => {
    const audio = document.querySelector<HTMLAudioElement>("audio.audition-export");
    if (!audio?.src.startsWith("blob:")) throw new Error("The audition does not play a Blob URL");
    const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { digest, size: bytes.length, mediaElements: document.querySelectorAll("audio, video").length, decodes: (window as AuditionWindow).qaDecodes ?? -1 };
  });
  // Memory: one media element streams the Blob; nothing decoded it into an AudioBuffer.
  expect(audition.mediaElements).toBe(1);
  expect(audition.decodes).toBe(0);
  await page.getByRole("button", { name: "Pause audition", exact: true }).click();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("Missing export download");
  const exported = await readFile(path);
  // 24-bit, 96 kHz, every source frame: the same bytes the audition played.
  expect(exported.length).toBe(44 + SECONDS * RATE * 6);
  expect(audition.size).toBe(exported.length);
  expect(audition.digest).toBe(createHash("sha256").update(exported).digest("hex"));
  return { digest: audition.digest, size: audition.size };
}
