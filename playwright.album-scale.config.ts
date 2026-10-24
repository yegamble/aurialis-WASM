import { defineConfig, devices } from "@playwright/test";

const endpoint = process.env.AURIALIS_OWNED_BROWSER_WS;
if (!endpoint && !process.argv.includes("--list")) throw new Error("Use the acknowledged Album scale supervisor; direct browser launch is not qualified.");
export default defineConfig({
  testDir: "./e2e", outputDir: process.env.AURIALIS_ALBUM_SCALE_OUTPUT ?? "./artifacts/album-scale-results",
  fullyParallel: false, forbidOnly: true, workers: 1, retries: 0, timeout: 1_800_000, globalTimeout: 3_600_000, reporter: [["list"], ["json", { outputFile: process.env.AURIALIS_ALBUM_SCALE_JSON ?? "artifacts/album-scale-results.json" }]],
  use: { ...(endpoint ? { connectOptions: { wsEndpoint: endpoint } } : {}), headless: true, trace: "off", launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {} },
  projects: [
    { name: "album-native-scale", testMatch: "album-scale.cases.ts", use: { ...devices["Desktop Chrome"], baseURL: process.env.AURIALIS_ALBUM_NATIVE_URL ?? "http://127.0.0.1:3847" } },
    { name: "album-browser-scale", testMatch: ["album-scale.cases.ts", "album-scale-browser.cases.ts"], use: { ...devices["Desktop Chrome"], baseURL: process.env.AURIALIS_ALBUM_BROWSER_URL ?? "http://127.0.0.1:3927" } },
  ],
});
