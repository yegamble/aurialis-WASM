import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { stemSplitAvailability } from "../src/lib/stem-split-copy";
import { uploadProject } from "./workflow-fixture";

type Execution = "native" | "browser";

/** Moves focus with Tab alone until the target holds it. */
async function tabTo(page: Page, target: Locator, limit = 60) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab did not reach the target within ${String(limit)} presses`);
}

/** Imports A then B, so B is the newest import every default would otherwise pick. */
async function importAThenB(page: Page) {
  const a = await uploadProject(page, "alpha-source.wav");
  const b = await uploadProject(page, "bravo-source.wav");
  expect(b).not.toBe(a);
  return { a, b };
}

async function linkTargets(scope: Locator) {
  return scope.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
}

async function expectUsableAt(page: Page, width: number, controls: Locator) {
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    if (!box) throw new Error(`Missing control at ${String(width)}px`);
    expect(box.width, `width at ${String(width)}px`).toBeGreaterThanOrEqual(44);
    expect(box.height, `height at ${String(width)}px`).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width, `clipped at ${String(width)}px`).toBeLessThanOrEqual(width);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `page overflowed at ${String(width)}px`).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations, `WCAG 2.2 AA at ${String(width)}px: ${JSON.stringify(results.violations)}`).toEqual([]);
}

export function registerTrackToolCases(execution: Execution) {
  const split = execution === "native";

  test.describe(`${execution} per-track tools`, () => {
    // The e2e server runs without the model, so it answers available: false and
    // Master and Tools would state that instead of linking. Mock a native server
    // that can split; e2e/smart-split.spec.ts covers the unavailable case.
    if (split) {
      test.beforeEach(async ({ page }) => {
        await page.route("**/api/stems/model", (route) => route.fulfill({
          json: { available: true, ready: true, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688, state: "loaded", accelerated: true, backend: "apple-accelerate", arch: "arm64" },
        }));
      });
    }
    test("Master opens each tool for its own track by keyboard after a newer import", async ({ page }) => {
      test.setTimeout(120_000);
      const { a } = await importAThenB(page);
      const tools = [
        { name: "Release check", path: "release-check", names: (at: Page) => at.getByRole("heading", { name: "alpha source", exact: true, level: 2 }) },
        { name: "Reference match", path: "reference", names: (at: Page) => at.getByRole("heading", { name: "alpha source", exact: true, level: 2 }) },
        ...(split ? [{ name: "Smart split", path: "split", names: (at: Page) => at.getByRole("button", { name: /^Split alpha source into \d stems$/u }) }] : []),
      ];
      for (const tool of tools) {
        await page.goto(`/master/${a}`);
        const nav = page.getByRole("navigation", { name: "Tools for alpha source", exact: true });
        await tabTo(page, nav.getByRole("link", { name: tool.name, exact: true }));
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/${tool.path}/${a}$`, "u"));
        await expect(tool.names(page)).toBeVisible();
      }
      await page.goto(`/master/${a}`);
      const nav = page.getByRole("navigation", { name: "Tools for alpha source", exact: true });
      if (split) await expect(nav.getByRole("link", { name: "Smart split", exact: true })).toHaveAttribute("href", `/split/${a}`);
      else {
        await expect(nav.getByRole("link", { name: "Smart split", exact: true })).toHaveCount(0);
        await expect(nav).toContainText(stemSplitAvailability(true));
      }
    });

    test("Tools chooser points every tool at the chosen track and opens it by keyboard", async ({ page }) => {
      test.setTimeout(120_000);
      const { a, b } = await importAThenB(page);
      await page.goto("/tools");
      const chooser = page.getByRole("combobox", { name: "Track", exact: true });
      await expect(chooser).toHaveValue(b);
      await tabTo(page, chooser);
      await chooser.selectOption(a);
      const list = page.getByRole("list", { name: "Tools for alpha source", exact: true });
      const expected = [...(split ? [`/split/${a}`] : []), `/reference/${a}`, `/release-check/${a}`];
      expect(await linkTargets(list)).toEqual(expected);
      if (!split) await expect(list).toContainText(stemSplitAvailability(true));
      await tabTo(page, list.getByRole("link", { name: /Release check/u }));
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/release-check/${a}$`, "u"));
      await expect(page.getByRole("heading", { name: "alpha source", exact: true, level: 2 })).toBeVisible();
    });

    test("track tools keep 44 px targets without overflow, axe clean, at 320 and 1440 px", async ({ page }) => {
      test.setTimeout(120_000);
      const { a } = await importAThenB(page);
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/master/${a}`);
        const nav = page.getByRole("navigation", { name: "Tools for alpha source", exact: true });
        await expect(nav.getByRole("link")).toHaveCount(split ? 3 : 2);
        await expectUsableAt(page, width, nav.getByRole("link"));
        await page.goto("/tools");
        const chooser = page.getByRole("combobox", { name: "Track", exact: true });
        await chooser.selectOption(a);
        await expectUsableAt(page, width, chooser.or(page.getByRole("list", { name: "Tools for alpha source", exact: true }).getByRole("link")));
      }
    });
  });
}
