import { expect, test } from "@playwright/test";
import { uploadProject } from "./workflow-fixture";

test("EQ response predicts the native shelf curve at mobile and desktop widths", async ({ page }) => {
  await uploadProject(page, "qa-eq-response.wav", 2);
  await page.getByRole("tab", { name: "Low", exact: true }).click();
  await page.getByRole("slider", { name: "Low frequency", exact: true }).fill("250");
  await page.getByRole("slider", { name: "Low Q", exact: true }).fill("0.707");
  await page.getByRole("slider", { name: "Low gain", exact: true }).fill("6");
  const chart = page.getByRole("img", { name: /^Approximate EQ response,/ });
  await expect(chart).toHaveAttribute("aria-label", /Low \(250 Hz\): \+6.0 dB/);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const points = await chart.locator("polyline").first().getAttribute("points");
    if (!points) throw new Error("Missing EQ response points");
    const probeX = 100 * Math.log(250 / 20) / Math.log(20000 / 20);
    const nearest = points.split(" ").map((point) => {
      const [x, y] = point.split(",").map(Number);
      return { distance: Math.abs((x ?? NaN) - probeX), gain: (30 - (y ?? NaN)) / 2 };
    }).sort((left, right) => left.distance - right.distance)[0];
    // Independent steady-state native sine measurement at 48 kHz. The allowance
    // covers the chart's finite logarithmic grid and two-decimal SVG rounding.
    expect(nearest?.gain).toBeGreaterThan(5.89847 - 0.25);
    expect(nearest?.gain).toBeLessThan(5.89847 + 0.25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});
