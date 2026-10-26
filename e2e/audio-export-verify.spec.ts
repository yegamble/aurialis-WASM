import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { decode } from "./audio-fixture"
import { uploadProject } from "./workflow-fixture"

test.describe("Accessible modal and honest WAV source export", () => {
  test("a fresh library contains no example projects or fabricated source", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Your library starts with your own audio.", { exact: false })).toBeVisible()
    await expect(page.getByText("Velvet Static", { exact: true })).toHaveCount(0)
    await page.goto("/master/placeholder")
    await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Export", exact: true })).toHaveCount(0)
  })

  test("uploaded audio exports full-length 24-bit PCM and Escape returns focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await uploadProject(page, "qa-modal-tone.wav")
    const exportButton = page.getByRole("button", { name: "Export", exact: true })
    await expect(exportButton).toBeEnabled()
    await exportButton.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Export “qa modal tone”")
    const pending = page.waitForEvent("download")
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click()
    const download = await pending
    expect(await download.failure()).toBeNull()
    const path = await download.path()
    expect(path).not.toBeNull()
    const audio = decode(await readFile(path!))
    expect(audio.bits).toBe(24)
    expect(audio.rate).toBe(48000)
    expect(audio.left).toHaveLength(48000)
    expect(audio.right).toHaveLength(48000)
    await expect(dialog.getByRole("status")).toContainText("Exported 24-bit PCM WAV")
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(exportButton).toBeFocused()
  })

  test("export converts to a delivery rate and can skip dither", async ({ page }) => {
    await uploadProject(page, "qa-rate-tone.wav")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "16-bit PCM", exact: true }).click()
    await dialog.getByRole("button", { name: "44.1 kHz", exact: true }).click()
    await dialog.getByRole("button", { name: "Off", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "44.1 kHz", exact: true })).toHaveAttribute("aria-pressed", "true")
    const pending = page.waitForEvent("download")
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click()
    const download = await pending
    expect(download.suggestedFilename()).toMatch(/-44\.1k-16bit\.wav$/)
    const audio = decode(await readFile((await download.path())!))
    expect(audio.bits).toBe(16)
    expect(audio.rate).toBe(44100)
    expect(audio.left).toHaveLength(44100)
    await expect(dialog.getByRole("status")).toContainText("Exported 16-bit PCM WAV without dither at 44.1 kHz (converted from 48 kHz)")
    // The native server's X-Aurialis-After-Peak-dBTP, measured after conversion.
    await expect(dialog.getByRole("status")).toContainText(/Delivered true peak -?\d+\.\d{2} dBTP at 44\.1 kHz\.$/)
    await expect(dialog.getByRole("group", { name: "Sample rate", exact: true }).getByRole("button")).toHaveText(["44.1 kHz", "48 kHz (source)", "88.2 kHz", "96 kHz"])
    await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Off", exact: true })).toHaveCount(0)
  })
})
