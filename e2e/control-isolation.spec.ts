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

  test("unavailable Deep and Smart Split cannot report simulated success", async ({ page }) => {
    const mutationRequests: string[] = []
    page.on("request", request => {
      if (request.method() === "POST") mutationRequests.push(request.url())
    })
    await page.goto("/master/demo-1")
    await expect(page.getByRole("tab", { name: "deep", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Analyze deeply", exact: true })).toHaveCount(0)
    await expect(page.getByText("Script v1", { exact: true })).toHaveCount(0)
    await page.goto("/split/demo-1")
    await expect(page.getByRole("heading", { name: "Stem separation", exact: true })).toBeVisible()
    await expect(page.getByText("Not available yet", { exact: true })).toBeVisible()
    await expect(page.getByText("Instrument separation is not connected to an audio model. No stems are generated here.", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Separate into stems", exact: true })).toHaveCount(0)
    await expect(page.getByRole("slider", { name: "Vocals level", exact: true })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Import a track", exact: true })).toHaveAttribute("href", "/")
    expect(mutationRequests).toEqual([])
  })
})
