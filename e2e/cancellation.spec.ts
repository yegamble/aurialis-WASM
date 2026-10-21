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

test("a failed import can retry the same file without reloading the page", async ({ page }) => {
  await page.goto("/");
  let first = true;
  await page.route("**/api/master/render", async (route) => {
    if (first) { first = false; await route.abort("failed"); }
    else await route.continue();
  });
  const file = { name: "retry-same-source.wav", mimeType: "audio/wav", buffer: fixture() };
  const input = page.getByLabel("Upload audio file");
  await input.setInputFiles(file);
  await expect(page.getByText("Could not reach the local audio server", { exact: false })).toBeVisible();
  expect(await input.inputValue(), "clearing the native chooser allows its next selection of the same file to fire change").toBe("");
  await input.setInputFiles(file);
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
});

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
    await expect(page.getByRole("button", { name: "Render offline preview", exact: true })).toBeEnabled();
  } finally {
    held.release();
  }
});

test("missing cached audio disables playback and Apply without inventing a source", async ({ page }) => {
  const id = await uploadProject(page, "missing-source.wav");
  await page.evaluate(async (id) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("aurialis-local", 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction("audio", "readwrite");
        transaction.objectStore("audio").delete(id);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  }, id);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry source", exact: true })).toBeVisible();
  for (const name of ["Play", "A Processed", "B Original"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply master direction", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply profile", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry source", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
});
