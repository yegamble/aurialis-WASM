import { test } from "@playwright/test";
import { verifyMonitorModes } from "../e2e/monitor-mode-cases";
test("browser Mono and Side monitor actual A/B with matched loudness and unchanged local export", async ({ page, context }, info) => {
  test.setTimeout(180_000); const uploads: string[] = [];
  context.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) uploads.push(request.method() + " " + request.url()); });
  const result = await verifyMonitorModes(page);
  if (uploads.length) throw new Error("Browser monitoring sent audio requests: " + uploads.join(", "));
  await info.attach("browser-monitor-speaker-and-export-evidence", { body: JSON.stringify(result), contentType: "application/json" });
});
