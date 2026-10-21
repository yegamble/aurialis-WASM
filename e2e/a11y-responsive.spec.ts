import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const VIEWPORTS = [
  { width: 320, height: 640, name: "mobile-320" },
  { width: 375, height: 812, name: "mobile-375" },
  { width: 390, height: 844, name: "mobile-390" },
  { width: 768, height: 1024, name: "tablet-768" },
  { width: 1024, height: 768, name: "desktop-1024" },
  { width: 1440, height: 900, name: "desktop-1440" },
]

const ROUTES = [
  "/",
  "/library",
  "/master/demo-1",
  "/split/demo-1",
  "/albums",
  "/reference/demo-1",
  "/release-check/demo-1",
  "/tools",
]

test.describe("Responsive Viewports (320px-1440px), COOP/COEP & WCAG 2.2 AA", () => {
  test("serves COOP/COEP headers and zero horizontal overflow across 320px-1440px", async ({
    page,
  }) => {
    const response = await page.goto("/")
    expect(response).not.toBeNull()
    const headers = response?.headers() ?? {}
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin")
    expect(headers["cross-origin-embedder-policy"]).toBe("require-corp")

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const route of ROUTES) {
        await page.goto(route)
        await expect(page.locator("main")).toBeVisible()
        const overflow = await page.evaluate(() => {
          return (
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 1
          )
        })
        expect(
          overflow,
          `Route ${route} overflowed horizontally at ${vp.width}px`,
        ).toBe(false)
      }
    }
  })

  test("passes axe WCAG 2.2 AA accessibility audit on core routes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    for (const route of ["/", "/library", "/master/demo-1", "/split/demo-1", "/tools"]) {
      await page.goto(route)
      await expect(page.locator("h1")).toBeVisible()
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(
        results.violations,
        `WCAG 2.2 AA violations on ${route}: ${JSON.stringify(results.violations)}`,
      ).toEqual([])
    }
  })
})
