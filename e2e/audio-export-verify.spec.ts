import { expect, test } from "@playwright/test"

test.describe("Accessible Modal Dialogs & Real Mastered WAV Export", () => {
  test("exports a real 24-bit WAV file via the accessible Export modal and supports Escape dismissal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/master/demo-1")

    // Click Export button -> opens accessible dialog (never window.alert)
    await page.getByRole("button", { name: "Export" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Export “Velvet Static”")

    // Trigger real WAV render & download
    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("button", { name: "Render & download WAV" }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain("velvet-static-24bit-48khz.wav")
    await expect(page.getByRole("status")).toContainText("Exported 24-bit / 48 kHz WAV")

    // Dismiss modal with Escape key
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })
})
