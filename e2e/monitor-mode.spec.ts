import { expect, test } from "@playwright/test";
import { verifyMonitorModes } from "./monitor-mode-cases";
test("Mono and Side monitor actual A/B with matched loudness and leave export unchanged", async ({ page }, info) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => { consoleErrors.push(error.message); });
  try {
    const result = await verifyMonitorModes(page);
    expect(result.measurements.some((item) => item.mode === "mono" && item.measure !== "render")).toBe(true);
    expect(result.measurements.some((item) => item.mode === "side" && item.measure !== "render")).toBe(true);
    await info.attach("monitor-speaker-and-export-evidence", { body: JSON.stringify(result), contentType: "application/json" });
  } finally {
    const runtime = { consoleErrors, alerts: (await page.getByRole("alert").allTextContents()).filter(Boolean) };
    if (runtime.consoleErrors.length || runtime.alerts.length) console.log("MONITOR RUNTIME", JSON.stringify(runtime));
    await info.attach("monitor-runtime-state", { body: JSON.stringify(runtime), contentType: "application/json" });
  }
});
