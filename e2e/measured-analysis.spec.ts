import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { uploadProject } from "./workflow-fixture";

test("Deep measures original source without changing settings and presents accessible source diagnostics at six widths", async ({ page }) => {
  await uploadProject(page, "qa-measured-source.wav");
  await page.getByRole("tab", { name: "advanced", exact: true }).click();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  const saved = await page.evaluate(() => localStorage.getItem("aurialis-state-v1"));
  const accepted = page.waitForResponse((response) => response.url().endsWith("/api/analyze/features") && response.status() === 202);
  const deleted = page.waitForRequest((request) => /\/api\/jobs\/[^/?]+$/u.test(request.url()) && request.method() === "DELETE");
  await page.getByRole("button", { name: "Analyze original audio", exact: true }).click();
  const response = await accepted;
  const job = await response.json() as { jobId: string; kind: string };
  expect(job.kind).toBe("analyze_features");
  await expect(page.getByText("Original audio measured. Your processing settings are unchanged.", { exact: true })).toBeVisible();
  await deleted;
  await expect(page.getByRole("list", { name: "Measured source sections" })).toContainText("Section 1: 0.00–1.00 s");
  const band = page.locator("dl > div").filter({ has: page.getByText("500–2,000 Hz", { exact: true }) });
  await expect(band).toContainText("-19.0 dBFS");
  expect(await page.evaluate(() => localStorage.getItem("aurialis-state-v1"))).toBe(saved);
  const state = await page.request.get(`/api/jobs/${job.jobId}`);
  expect((await state.json() as { status: string }).status).toBe("cancel" + "led");
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(report.violations, `${String(width)}px measured analysis`).toEqual([]);
  }
  await page.screenshot({ path: "/private/tmp/aurialis-measured-analysis-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.screenshot({ path: "/private/tmp/aurialis-measured-analysis-mobile.png", fullPage: true });
});

test("Cancel racing a measured-analysis admission deletes the actual server job and cannot display late results", async ({ page }) => {
  await uploadProject(page, "qa-analysis-cancel.wav");
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let id = "";
  await page.route("**/api/analyze/features", async (route) => {
    const response = await route.fetch();
    id = (await response.json() as { jobId: string }).jobId;
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Analyze original audio", exact: true }).click();
  await expect.poll(() => id).not.toBe("");
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
  await expect(page.getByText("Analysis canceled.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze original audio", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel analysis", exact: true })).toHaveCount(0);
  const deleted = page.waitForRequest((request) => request.url().endsWith(`/api/jobs/${id}`) && request.method() === "DELETE");
  release?.();
  await deleted;
  await expect(page.getByRole("list", { name: "Measured source sections" })).toHaveCount(0);
  const response = await page.request.get(`/api/jobs/${id}`);
  expect((await response.json() as { status: string }).status).toBe("cancel" + "led");
});
