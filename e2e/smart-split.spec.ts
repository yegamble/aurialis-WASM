import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { fixture } from "./audio-fixture"
import { uploadProject } from "./workflow-fixture"

// The test server runs without the 176 MB model, so the Smart Split API is
// mocked at the network boundary; the page, polling, players and downloads are real.
const speed = { windowSeconds: 20, hopSeconds: 10, idleSecondsPerWindow: 32, busySecondsPerWindow: 173 }
const stems = [{ id: "vocals", name: "Vocals", color: "#b4543c" }, { id: "instrumental", name: "Instrumental", color: "#596c52" }]

test.describe("Smart Split (native, mocked model)", () => {
  test("a cached model splits a song into playable, named stems and hands back to mastering", async ({ page }) => {
    test.setTimeout(90_000)
    const id = await uploadProject(page, "Night Drive.wav", 25)
    let deleted = 0
    await page.route("**/api/stems/model", (route) => route.fulfill({
      json: { available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688, state: "cached", accelerated: true, backend: "apple-accelerate", arch: "arm64", speed },
    }))
    await page.route("**/api/separate", async (route) => {
      expect(route.request().method()).toBe("POST")
      expect(route.request().postData() ?? "").toContain('name="stems"\r\n\r\n2')
      await route.fulfill({ status: 202, json: { jobId: "job-split", status: "running", progress: 40, stage: "Separating window 2 of 5" } })
    })
    let polls = 0
    await page.route((url) => url.pathname === "/api/jobs/job-split", async (route) => {
      if (route.request().method() === "DELETE") {
        deleted++
        await route.fulfill({ json: {} })
        return
      }
      polls++
      await route.fulfill({ json: { jobId: "job-split", status: "done", progress: 100, stage: "Complete", stems } })
    })
    await page.route("**/api/jobs/job-split/stems/*", (route) => route.fulfill({ contentType: "audio/wav", body: fixture(440, 1) }))

    await page.goto(`/split/${id}`)
    const note = page.getByRole("status").filter({ hasText: "separation model" })
    await expect(note).toHaveText("The separation model is saved on this computer and verified. The first split loads it; nothing to download.")
    await expect(page.getByText(/^Estimated split time for this 0:25 song: about 3 minutes \(5 model windows at about 32 s each/u)).toBeVisible()
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
      expect(results.violations, `WCAG 2.2 AA with the estimate at ${String(width)}px`).toEqual([])
    }

    await page.getByRole("button", { name: "2", exact: true }).click()
    await page.getByRole("button", { name: "Split Night Drive into 2 stems", exact: true }).click()
    const list = page.getByRole("list", { name: "Separated stems", exact: true })
    await expect(list.getByRole("listitem")).toHaveCount(2)
    expect(polls, "the running job was polled to completion").toBeGreaterThanOrEqual(1)

    for (const stem of stems) {
      const player = page.getByLabel(`Play ${stem.name}`, { exact: true })
      await expect(player).toHaveAttribute("src", `/api/jobs/job-split/stems/${stem.id}`)
      const duration = await player.evaluate((element: HTMLAudioElement) => new Promise<number>((resolve, reject) => {
        element.addEventListener("loadedmetadata", () => { resolve(element.duration) }, { once: true })
        element.addEventListener("error", () => { reject(new Error("stem did not load")) }, { once: true })
        element.load()
      }))
      expect(duration, `${stem.name} player duration`).toBeCloseTo(1, 1)

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: `Download ${stem.name}`, exact: true }).click(),
      ])
      expect(download.suggestedFilename()).toBe(`Night Drive - ${stem.name}.wav`)
    }
    await expect(note).toHaveText("The separation model is saved on this computer and verified. The first split loads it; nothing to download.")

    // The handoff back to mastering keeps the same track and releases the job.
    await page.getByRole("link", { name: "Back to master", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/master/${id}$`, "u"))
    await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 })
    await expect.poll(() => deleted).toBeGreaterThanOrEqual(1)
  })

  test("a plain-Go build keeps Split disabled with plain copy and no estimate", async ({ page }) => {
    const id = await uploadProject(page, "Night Drive.wav", 1)
    let separations = 0
    await page.route("**/api/stems/model", (route) => route.fulfill({
      json: { available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688, state: "absent", accelerated: false, backend: "portable-go" },
    }))
    await page.route("**/api/separate", async (route) => { separations++; await route.abort() })
    await page.goto(`/split/${id}`)
    await expect(page.getByRole("status").filter({ hasText: "plain Go" })).toHaveText("Smart Split is off in this build: it runs the model in plain Go, which did not finish one 20-second window in 30 minutes. Splitting needs the macOS build, which uses Apple Accelerate.")
    await expect(page.getByRole("button", { name: "Split Night Drive into 4 stems", exact: true })).toBeDisabled()
    await expect(page.getByText(/Estimated split time/u)).toHaveCount(0)
    expect(separations).toBe(0)
  })
})
