import { test } from "@playwright/test";
import { verifyMonitorModes } from "./monitor-mode-cases";
test("Mono and Side monitor actual A/B with matched loudness and leave export unchanged", async ({ page }, info) => {
  test.setTimeout(180_000);
  await info.attach("monitor-speaker-and-export-evidence", { body: JSON.stringify(await verifyMonitorModes(page)), contentType: "application/json" });
});
