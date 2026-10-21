import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { fixture, decode } from "./audio-fixture"

test.describe("Accessible modal and honest WAV source export", () => {
  test("a design example without source audio cannot preview or export fabricated audio", async ({ page }) => {
    await page.goto("/master/demo-1")
    await expect(page.getByRole("status")).toContainText("This design example has no uploaded audio")
    await expect(page.getByRole("button", { name: "Export", exact: true })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Render preview", exact: true })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled()
    await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeDisabled()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })

  test("uploaded audio exports full-length 24-bit PCM and Escape returns focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")
    await page.getByLabel("Upload audio file").setInputFiles({ name: "qa-modal-tone.wav", mimeType: "audio/wav", buffer: fixture() })
    await expect(page).toHaveURL(/\/master\/track-/)
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
})
