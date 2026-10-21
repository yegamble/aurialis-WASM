import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { decode, fixture, dbRatio } from "./audio-fixture"

async function upload(page: Page, name: string, frequency = 1000): Promise<string> {
  await page.goto("/")
  await page.getByLabel("Upload audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: fixture(frequency) })
  await expect(page).toHaveURL(/\/master\/track-/)
  await expect(page.getByRole("heading", { name: name.replace(/\.wav$/, "").replace(/-/g, " "), exact: true })).toBeVisible()
  return page.url()
}

async function exported(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click()
  const pending = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click()
  const download = await pending
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  expect(path).not.toBeNull()
  const decoded = decode(await readFile(path!))
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  return decoded
}

test("uploaded source survives export, independent gain controls, reload and second-track isolation", async ({ page }) => {
  const trackURL = await upload(page, "qa-independent-tone.wav")
  await page.getByRole("tab", { name: "advanced", exact: true }).click()
  await page.getByRole("button", { name: "Reset modules", exact: true }).click()
  const input = page.getByRole("slider", { name: "Input gain", exact: true })
  await expect(input).toHaveValue("0")
  const neutral = await exported(page)
  const source = decode(fixture())
  expect(neutral.rate).toBe(48000)
  expect(neutral.bits).toBe(32)
  expect(neutral.left).toHaveLength(source.left.length)
  expect(neutral.right).toHaveLength(source.right.length)
  for (const channel of ["left", "right"] as const) {
    expect(Math.max(...neutral[channel].map((x, i) => Math.abs(x - (source[channel][i] ?? Infinity))))).toBeLessThan(1 / 32768)
  }
  const untouched = await page.getByRole("slider").evaluateAll((sliders) => sliders.filter((slider) => slider.getAttribute("aria-label") !== "Input gain").map((slider) => ({ label: slider.getAttribute("aria-label"), value: (slider as HTMLInputElement).value })))
  await input.fill("6")
  await expect(input).toHaveValue("6")
  expect(await page.getByRole("slider").evaluateAll((sliders) => sliders.filter((slider) => slider.getAttribute("aria-label") !== "Input gain").map((slider) => ({ label: slider.getAttribute("aria-label"), value: (slider as HTMLInputElement).value })))).toEqual(untouched)
  const louder = await exported(page)
  expect(dbRatio(louder.left, neutral.left)).toBeCloseTo(6, 2)
  expect(dbRatio(louder.right, neutral.right)).toBeCloseTo(6, 2)
  await page.getByRole("button", { name: "Render preview", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { aurialisDSPReady?: boolean }).aurialisDSPReady)).toBe(true)
  await page.getByRole("button", { name: "B Processed", exact: true }).click()
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2)
  const playbackBytes = await page.locator("audio").evaluate(async (audio: HTMLAudioElement) => {
    const response = await fetch(audio.src)
    if (!response.ok) throw new Error("Cannot read actual playback source")
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  })
  const playback = decode(Buffer.from(playbackBytes))
  expect(playback.left).toHaveLength(louder.left.length)
  for (const channel of ["left", "right"] as const) {
    expect(Math.max(...playback[channel].map((sample, i) => Math.abs(sample - (louder[channel][i] ?? Infinity))))).toBeLessThan(1e-5)
  }
  await page.getByRole("button", { name: "Play", exact: true }).click()
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
  await page.getByRole("button", { name: "A Original", exact: true }).click()
  const originalBytes = await page.locator("audio").evaluate(async (audio: HTMLAudioElement) => {
    const response = await fetch(audio.src)
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  })
  const original = decode(Buffer.from(originalBytes))
  expect(original.left).toHaveLength(source.left.length)
  expect(Math.max(...original.left.map((sample, i) => Math.abs(sample - (source.left[i] ?? Infinity))))).toBeLessThan(1 / 32768)
  await page.reload()
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("6")
  const restored = await exported(page)
  expect(restored.left).toEqual(louder.left)
  expect(restored.right).toEqual(louder.right)
  await upload(page, "qa-second-tone.wav", 2000)
  await page.getByRole("tab", { name: "advanced", exact: true }).click()
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("0")
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("-6")
  await page.goto(trackURL)
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("6")
})
