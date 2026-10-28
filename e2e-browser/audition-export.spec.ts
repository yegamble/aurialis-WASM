import { test } from "@playwright/test";
import { verifyAuditionMatchesExport } from "../e2e/audition-export-cases";

// The browser build renders the audition in its local Go/WASM worker, like Export.
test("browser build: Audition export plays the exact Export WAV of a 96 kHz source, decoding nothing", async ({ page }) => {
  test.setTimeout(180_000);
  await verifyAuditionMatchesExport(page);
});
