import { test } from "@playwright/test";
import { verifyMatchedAB } from "../e2e/matched-ab-cases";

test("browser build: Match loudness levels A and B through the live path without changing export (V1-11)", async ({ page }, info) => {
  test.setTimeout(150_000);
  const evidence = await verifyMatchedAB(page);
  await info.attach("matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 browser evidence", JSON.stringify(evidence));
});
