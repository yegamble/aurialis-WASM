import { test } from "@playwright/test";
import { verifyExportDuringMeasurement, verifyDeepMatchedAB, verifyLimitedMatchedAB, verifyMatchedAB } from "./matched-ab-cases";

test("Equal-loudness A/B levels A and B through the live path without changing export (V1-11)", async ({ page }, info) => {
  test.setTimeout(120_000);
  const evidence = await verifyMatchedAB(page);
  await info.attach("matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 native evidence", JSON.stringify(evidence));
});

test("Equal-loudness A/B holds ±0.5 LU at the speakers on a heavily limited master (V1-11 Round E)", async ({ page }, info) => {
  test.setTimeout(180_000);
  const evidence = await verifyLimitedMatchedAB(page);
  await info.attach("limited-matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 native limited evidence", JSON.stringify(evidence));
});

test("Export right after an edit succeeds while Equal-loudness A/B measures (V1-11 Round E REQUIRED-2)", async ({ page }) => {
  test.setTimeout(180_000);
  await verifyExportDuringMeasurement(page);
});

test("Equal-loudness A/B matches an applied Deep script without changing export", async ({ page }, info) => {
  test.setTimeout(240_000);
  const evidence = await verifyDeepMatchedAB(page);
  await info.attach("deep-matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
});
