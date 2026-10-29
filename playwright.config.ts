import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PLAYWRIGHT_PORT || "3847";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Shard individual independent tests; one worker still serializes audio per VM.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL: BASE_URL,
    trace: "off",
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {},
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bash scripts/serve-e2e.sh ${PORT}`,
    url: `${BASE_URL}/build-target-native.json`,
    reuseExistingServer: false,
    // The server command bounds a local cold build to 8 minutes and its start to 30 seconds.
    timeout: 9 * 60_000,
  },
});
