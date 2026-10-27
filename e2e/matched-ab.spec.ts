import { test } from "@playwright/test";
import { verifyMatchedAB } from "./matched-ab-cases";

test("Match loudness levels A and B through the live path without changing export (V1-11)", async ({ page }, info) => {
  test.setTimeout(120_000);
  const evidence = await verifyMatchedAB(page);
  await info.attach("matched-ab-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  console.log("V1-11 native evidence", JSON.stringify(evidence));
});
