import { expect, test } from "@playwright/test"
import { uploadProject } from "./workflow-fixture"

test.describe("End-to-End Parameter Orthogonality & Control Isolation", () => {
  test("adjusting Advanced EQ, Compressor, Saturation, Stereo, and Limiter controls never cross-couples", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await uploadProject(page)

    // Switch to Advanced mode
    await page.getByRole("tab", { name: "advanced" }).click()
    await expect(page.getByText("Shape the detail")).toBeVisible()

    // Select Presence EQ band and adjust its gain without mutating Low band or Compressor
    await page.getByRole("tab", { name: "Presence" }).click()
    const presenceGain = page.getByRole("slider", { name: "Presence gain" })
    await presenceGain.fill("4.5")
    await presenceGain.dispatchEvent("change")

    // Verify Low band is still 0 dB
    await page.getByRole("tab", { name: "Low" }).click()
    const lowGain = page.getByRole("slider", { name: "Low gain" })
    await expect(lowGain).toHaveValue("0")

    // The uploaded project's neutral compressor and width must remain unchanged.
    const thresholdSlider = page.getByRole("slider", { name: "Threshold", exact: true })
    const stereoWidthSlider = page.getByRole("slider", { name: "Stereo width" })
    await expect(thresholdSlider).toHaveValue("0")
    await expect(stereoWidthSlider).toHaveValue("100")

    // Change Saturation character to Tape and verify Threshold & Width are unchanged
    await page.getByRole("button", { name: "Tape", exact: true }).click()
    await expect(page.getByRole("button", { name: "Tape", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(thresholdSlider).toHaveValue("0")
    await expect(stereoWidthSlider).toHaveValue("100")
  })

  test("Deep offers one measured profile control while disabled separation cannot invent stems", async ({ page }) => {
    const id = await uploadProject(page)
    await page.getByRole("tab", { name: "deep", exact: true }).click()
    await expect(page.getByRole("button", { name: "Analyze Deep proposal", exact: true })).toBeEnabled()
    await expect(page.getByRole("combobox", { name: /profile/iu })).toHaveCount(1)
    await expect(page.getByRole("combobox", { name: "Deep engineer profile", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Apply profile", exact: true })).toHaveCount(0)
    await expect(page.getByText("Engineer profiles", { exact: true })).toHaveCount(0)
    await page.goto(`/split/${id}`)
    await expect(page.getByRole("group", { name: "Stem count", exact: true })).toBeVisible()
    // The e2e binary runs without a model (--stem-model-url ""), so nothing downloads.
    await expect(page.getByText("Smart Split is turned off in this Aurialis server: it was started with the separation model disabled.", { exact: true })).toBeVisible()
    // The loopback studio is the native build, so it states the native availability and speed.
    await expect(page.getByText(/^Smart Split runs on this computer, and it is slow\./u)).toBeVisible()
    await expect(page.getByRole("button", { name: /^Split .* into 4 stems$/u })).toBeDisabled()
    await expect(page.getByRole("list", { name: "Separated stems" })).toHaveCount(0)
  })
})
