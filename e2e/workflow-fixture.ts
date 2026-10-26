import { expect, type Page } from "@playwright/test";
import { fixture } from "./audio-fixture";

export async function uploadProject(page: Page, name = "qa-workflow.wav", seconds = 1): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Import audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: fixture(1000, seconds) });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  return new URL(page.url()).pathname.split("/")[2] ?? "";
}
