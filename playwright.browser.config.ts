import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-browser",
  outputDir: "./artifacts/browser-local/static-smoke",
  globalSetup: "./scripts/prepare-browser-tests.mjs",
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3927",
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {},
  },
  projects: [{ name: "chromium-static-browser", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm run dev:browser",
    url: "http://127.0.0.1:3927/",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CLOUDFLARE_SEND_METRICS: "false" },
  },
});
