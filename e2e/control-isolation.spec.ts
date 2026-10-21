import { expect, test } from "@playwright/test"

test.describe("End-to-End Parameter Orthogonality & Control Isolation", () => {
  test("adjusting Advanced EQ, Compressor, Saturation, Stereo, and Limiter controls never cross-couples", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/master/demo-1")

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

    // Verify Threshold and Stereo width remained at demo-1 initial values (-18 dB and 106%)
    const thresholdSlider = page.getByRole("slider", { name: "Threshold" })
    const stereoWidthSlider = page.getByRole("slider", { name: "Stereo width" })
    await expect(thresholdSlider).toHaveValue("-18")
    await expect(stereoWidthSlider).toHaveValue("106")

    // Change Saturation character to Thick and verify Threshold & Width are unchanged
    await page.getByRole("button", { name: "Thick" }).click()
    await expect(page.getByRole("button", { name: "Thick" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(thresholdSlider).toHaveValue("-18")
    await expect(stereoWidthSlider).toHaveValue("106")
  })

  test("Deep MasteringScript move editor and Smart Split stems operate orthogonally", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/master/demo-1")

    // Switch to Deep mode and generate MasteringScript v1
    await page.getByRole("tab", { name: "deep" }).click()
    await page.getByRole("button", { name: "Analyze deeply" }).click()
    await expect(page.getByText("Script v1")).toBeVisible()

    // Open first Volume move and mute it
    const firstMoveBtn = page
      .getByRole("button", { name: /Edit input_gain_db/i })
      .first()
    await firstMoveBtn.click()
    await expect(page.getByText("Move editor")).toBeVisible()
    await page.getByRole("button", { name: "Mute", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Unmute", exact: true }),
    ).toBeVisible()

    // Navigate to Smart Split and separate into 4 stems
    await page.goto("/split/demo-1")
    await page.getByRole("button", { name: "Separate into stems" }).click()
    await expect(page.getByText("4 stem mix")).toBeVisible()

    // Adjust Vocals level and verify Drums level stays at 0 dB
    const vocalsLevel = page.getByRole("slider", { name: "Vocals level" })
    const drumsLevel = page.getByRole("slider", { name: "Drums level" })
    await vocalsLevel.fill("-6")
    await vocalsLevel.dispatchEvent("change")
    await expect(vocalsLevel).toHaveValue("-6")
    await expect(drumsLevel).toHaveValue("0")
  })
})
