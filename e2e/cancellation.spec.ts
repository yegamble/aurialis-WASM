import { expect, test, type Page, type Request } from "@playwright/test";
import { fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";

// cspell:words requestfailed

// Keep the response pending so cancellation cannot accidentally pass because
// a tiny fixture finished processing before the navigation or close action.
async function holdRender(page: Page) {
  let release = () => {};
  let capture = (_request: Request) => {};
  const seen = new Promise<Request>((resolve) => { capture = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/master/render", async (route) => {
    capture(route.request());
    await held;
    await route.abort("failed").catch(() => {});
  });
  return { seen, release };
}

test("leaving Home cancels a pending import without creating or opening a stale project", async ({ page }) => {
  await page.goto("/");
  const held = await holdRender(page);
  try {
    await page.getByLabel("Upload audio file").setInputFiles({ name: "cancel-import.wav", mimeType: "audio/wav", buffer: fixture() });
    const request = await held.seen;
    const canceled = page.waitForEvent("requestfailed", (candidate) => candidate === request);
    await page.getByRole("link", { name: "Library", exact: true }).first().click();
    await expect(page).toHaveURL(/\/library$/);
    await canceled;
    expect(await page.evaluate(() => {
      const raw = localStorage.getItem("aurialis-state-v1");
      return raw ? (JSON.parse(raw) as { tracks: unknown[] }).tracks.length : 0;
    })).toBe(0);
    await expect(page).toHaveURL(/\/library$/);
  } finally {
    held.release();
  }
});

test("closing the export dialog cancels its pending render and keeps the source project open", async ({ page }) => {
  const id = await uploadProject(page, "cancel-export.wav");
  const held = await holdRender(page);
  try {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    const request = await held.seen;
    const canceled = page.waitForEvent("requestfailed", (candidate) => candidate === request);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await canceled;
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/master/${id}$`));
    await expect(page.getByRole("button", { name: "Render preview", exact: true })).toBeEnabled();
  } finally {
    held.release();
  }
});

test("Simple and profile Apply wait for the actual source to finish loading", async ({ page }) => {
  const id = await uploadProject(page, "loading-source.wav");
  let release = () => {};
  let capture = () => {};
  const seen = new Promise<void>((resolve) => { capture = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/master/render", async (route) => {
    capture();
    await held;
    await route.continue();
  });
  try {
    await page.goto(`/master/${id}`);
    await seen;
    await page.getByRole("tab", { name: "simple", exact: true }).click();
    await expect(page.getByRole("button", { name: "Apply master direction", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "deep", exact: true }).click();
    const apply = page.getByRole("button", { name: "Apply profile", exact: true });
    await expect(apply).toBeDisabled();
    release();
    await expect(apply).toBeEnabled({ timeout: 30_000 });
    await apply.click();
    await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  } finally {
    release();
  }
});
