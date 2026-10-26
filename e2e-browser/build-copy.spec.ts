import { expect, test } from "@playwright/test";
import { stemSplitAvailability } from "../src/lib/stem-split-copy";

/** Copy that is false in the browser build: no app is distributed and no local server runs. */
const FALSE_IN_BROWSER = /desktop\s+app|local\s+Go\s+server|processed by your local/iu;
const ROUTES = ["/", "/library", "/albums", "/albums/placeholder", "/tools", "/master/placeholder", "/split/placeholder", "/reference/placeholder", "/release-check/placeholder"];

test("no browser-build page claims a desktop app or a local Go server, before or after hydration", async ({ page, request }) => {
  for (const route of ROUTES) {
    const html = await (await request.get(route)).text();
    expect(html, `prerendered ${route}`).not.toMatch(FALSE_IN_BROWSER);
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    expect(await page.locator("body").innerText(), `rendered ${route}`).not.toMatch(FALSE_IN_BROWSER);
  }
});

test("Home, Tools and Split state the same browser-build Smart Split availability", async ({ page }) => {
  const availability = stemSplitAvailability(true);
  for (const route of ["/", "/tools", "/split/placeholder"]) {
    await page.goto(route);
    await expect(page.getByText(availability, { exact: false }).first(), route).toBeVisible();
  }
  await page.goto("/");
  await expect(page.getByText("Audio is processed on this device with WebAssembly in your browser", { exact: false })).toBeVisible();
});
