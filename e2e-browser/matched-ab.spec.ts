import { test } from "@playwright/test";
import { verifyDeepMatchedAB, verifyLimitedMatchedAB, verifyMatchedAB } from "../e2e/matched-ab-cases";

test("browser build: Equal-loudness A/B levels A and B through the live path without changing export (V1-11)", async ({ page }, info) => {
  test.setTimeout(150_000);
  const evidence = await verifyMatchedAB(page);
  await info.attach("matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 browser evidence", JSON.stringify(evidence));
});

test("browser build: Equal-loudness A/B holds ±0.5 LU at the speakers on a heavily limited master (V1-11 Round E)", async ({ page }, info) => {
  test.setTimeout(240_000);
  const evidence = await verifyLimitedMatchedAB(page);
  await info.attach("limited-matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 browser limited evidence", JSON.stringify(evidence));
});

test("browser build: Equal-loudness A/B matches an applied Deep script without changing export", async ({ page }, info) => {
  test.setTimeout(240_000);
  const evidence = await verifyDeepMatchedAB(page);
  await info.attach("deep-matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
});
