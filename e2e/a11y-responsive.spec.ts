import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { fixture } from "./audio-fixture"
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
    for (const name of ["Live loudness of the processed output", "Measured audio levels"]) {
      const meters = page.getByRole("region", { name, exact: true })
      await meters.focus()
      await expect(meters).toBeFocused()
      await expect.poll(() => meters.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
      await page.keyboard.press("ArrowRight")
      await expect.poll(() => meters.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    }
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

  test("Export dialog names its choice groups and reflows without overflow or wrapped choices", async ({ page }) => {
    // A 32 kHz source is not a delivery rate, so the dialog shows all five rate choices.
    const wav = fixture(1000, 1)
    wav.writeUInt32LE(32000, 24)
    wav.writeUInt32LE(32000 * 4, 28)
    await page.goto("/")
    await page.getByLabel("Import audio file").setInputFiles({ name: "qa-export-32k.wav", mimeType: "audio/wav", buffer: wav })
    await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 })
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.getByRole("button", { name: "Export", exact: true }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: "16-bit PCM", exact: true }).click()
      const rates = dialog.getByRole("group", { name: "Sample rate", exact: true })
      await expect(rates.getByRole("button")).toHaveText(["32 kHz (source)", "44.1 kHz", "48 kHz", "88.2 kHz", "96 kHz"])
      await expect(rates.getByRole("button", { name: "32 kHz (source)", exact: true })).toHaveAttribute("aria-pressed", "true")
      await expect(dialog.getByRole("group", { name: "Dither", exact: true }).getByRole("button")).toHaveText(["TPDF", "Off"])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `Export dialog overflowed at ${vp.width}px`).toBeLessThanOrEqual(0)
      const choices = await dialog.locator(".choice").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect(), range = document.createRange()
        range.selectNodeContents(element)
        return { label: element.textContent ?? "", width: box.width, height: box.height, right: box.right,
          lines: new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size }
      }))
      expect(choices).toHaveLength(10)
      for (const choice of choices) {
        expect(choice.lines, `${choice.label} wrapped at ${vp.width}px`).toBe(1)
        expect(choice.width, `${choice.label} width at ${vp.width}px`).toBeGreaterThanOrEqual(44)
        expect(choice.height, `${choice.label} height at ${vp.width}px`).toBeGreaterThanOrEqual(44)
        expect(choice.right, `${choice.label} clipped at ${vp.width}px`).toBeLessThanOrEqual(vp.width)
      }
      if (vp.width === 320 || vp.width === 1440) {
        const results = await new AxeBuilder({ page })
          .include('[role="dialog"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
        expect(results.violations, `WCAG 2.2 AA in the Export dialog at ${vp.width}px: ${JSON.stringify(results.violations)}`).toEqual([])
      }
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
    }
  })

  test("separated stems keep a usable player per stem from 320px to 1440px, axe clean", async ({ page }) => {
    test.setTimeout(90_000)
    const id = await uploadProject(page)
    // The test server runs without the model, so the Smart Split API is mocked; the layout is real.
    const stems = [
      { id: "vocals", name: "Vocals", color: "#b4543c" }, { id: "drums", name: "Drums", color: "#596c52" },
      { id: "bass", name: "Bass", color: "#8a6529" }, { id: "other", name: "Other", color: "#78638b" },
    ]
    await page.route("**/api/stems/model", (route) => route.fulfill({ json: { available: true, ready: true, downloading: false, downloadedBytes: 1, totalBytes: 1 } }))
    await page.route("**/api/separate", (route) => route.fulfill({ status: 202, json: { jobId: "job-layout", status: "done", progress: 100, stage: "Complete", stems } }))
    await page.route("**/api/jobs/job-layout/stems/*", (route) => route.fulfill({ contentType: "audio/wav", body: fixture(440, 0.5) }))
    await page.route("**/api/jobs/job-layout", (route) => route.fulfill({ json: {} }))
    await page.goto(`/split/${id}`)
    await page.getByRole("button", { name: /^Split .+ into 4 stems$/u }).click()
    const list = page.getByRole("list", { name: "Separated stems", exact: true })
    await expect(list.getByRole("listitem")).toHaveCount(4)
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const stem of stems) {
        const player = page.getByLabel(`Play ${stem.name}`, { exact: true })
        await expect(player).toBeVisible()
        const box = await player.boundingBox()
        expect(box?.width, `${stem.name} player width at ${vp.width}px`).toBeGreaterThanOrEqual(240)
        expect((box?.x ?? 0) + (box?.width ?? 0), `${stem.name} player clipped at ${vp.width}px`).toBeLessThanOrEqual(vp.width)
        const download = page.getByRole("button", { name: `Download ${stem.name}`, exact: true })
        const target = await download.boundingBox()
        expect(target?.width).toBeGreaterThanOrEqual(44)
        expect(target?.height).toBeGreaterThanOrEqual(44)
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `Split page overflowed at ${vp.width}px`).toBeLessThanOrEqual(0)
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(results.violations, `WCAG 2.2 AA with stems at ${vp.width}px: ${JSON.stringify(results.violations)}`).toEqual([])
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
