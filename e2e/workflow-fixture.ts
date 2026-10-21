import { expect, type Page } from "@playwright/test";
import { fixture } from "./audio-fixture";

export async function uploadProject(page: Page, name = "qa-workflow.wav", seconds = 1): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: fixture(1000, seconds) });
  await expect(page).toHaveURL(/\/master\/track-/);
  await expect(page.getByRole("button", { name: "Render preview", exact: true })).toBeEnabled();
  return new URL(page.url()).pathname.split("/")[2] ?? "";
}
