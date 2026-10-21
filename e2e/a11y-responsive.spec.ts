import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { uploadProject } from "./workflow-fixture"

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
  "/master/PROJECT",
  "/split/PROJECT",
  "/albums",
  "/albums/ALBUM",
  "/reference/PROJECT",
  "/release-check/PROJECT",
  "/tools",
]

test.describe("Responsive Viewports (320px-1440px), COOP/COEP & WCAG 2.2 AA", () => {
  test("mobile level meters can be scrolled with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await uploadProject(page)
    const meters = page.getByRole("region", { name: "Measured audio levels", exact: true })
    await meters.focus()
    await expect(meters).toBeFocused()
    await expect.poll(() => meters.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
    await page.keyboard.press("ArrowRight")
    await expect.poll(() => meters.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  })

  test("audio touch targets retain 44 CSS pixels at the editorial font size", async ({ page }) => {
    await uploadProject(page)
    for (const width of [320, 375, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const selector of [".eq-handle", 'input[type="range"]', ".module-disclosure > summary", ".button"]) {
        const controls = page.locator(selector)
        expect(await controls.count(), `${selector} must exercise rendered controls`).toBeGreaterThan(0)
        for (const control of await controls.all()) {
          if (!(await control.isVisible())) continue
          const box = await control.boundingBox()
          expect(box?.width, `${selector} width at ${width}px`).toBeGreaterThanOrEqual(44)
          expect(box?.height, `${selector} height at ${width}px`).toBeGreaterThanOrEqual(44)
        }
      }
      for (const marker of await page.locator(".eq-handle .eq-marker").all()) {
        if (!(await marker.isVisible())) continue
        const box = await marker.boundingBox()
        if (!box) throw new Error("Missing visible EQ marker")
        expect(box.width / box.height, `round EQ artwork at ${width}px`).toBeCloseTo(1, 2)
      }
    }
  })

  test("serves COOP/COEP headers and zero horizontal overflow across 320px-1440px", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = await uploadProject(page)
    await page.goto("/albums")
    await page.getByRole("button", { name: "New album", exact: true }).click()
    await page.getByRole("link", { name: /Untitled sequence 1/ }).click()
    await expect(page).toHaveURL(/\/albums\/album-/)
    const album = new URL(page.url()).pathname.split("/")[2] ?? ""
    const response = await page.goto("/")
    expect(response).not.toBeNull()
    const headers = response?.headers() ?? {}
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin")
    expect(headers["cross-origin-embedder-policy"]).toBe("require-corp")

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const route of ROUTES) {
        await page.goto(route.replace("PROJECT", id).replace("ALBUM", album))
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

  for (const vp of VIEWPORTS) {
    test(`passes axe WCAG 2.2 AA at ${vp.width}px`, async ({ page }) => {
      const id = await uploadProject(page)
      await page.goto("/albums")
      await page.getByRole("button", { name: "New album", exact: true }).click()
      await page.getByRole("link", { name: /Untitled sequence 1/ }).click()
      await expect(page).toHaveURL(/\/albums\/album-/)
      const album = new URL(page.url()).pathname.split("/")[2] ?? ""
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const route of ROUTES) {
        await page.goto(route.replace("PROJECT", id).replace("ALBUM", album))
        await expect(page.locator("h1")).toBeVisible()
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
        expect(
          results.violations,
          `WCAG 2.2 AA on ${route} at ${vp.width}px: ${JSON.stringify(results.violations)}`,
        ).toEqual([])
      }
    })
  }
})
