import { defineConfig, devices } from "@playwright/test";
const external = process.env.PLAYWRIGHT_ENGINE_BASE_URL;
const target = process.env.PLAYWRIGHT_ENGINE_TARGET ?? "native";
if (target !== "native" && target !== "browser") throw new Error("Choose native or browser engine qualification.");
if (target === "browser" && !external) throw new Error("Browser engine qualification needs a receipt-verified static server URL in PLAYWRIGHT_ENGINE_BASE_URL.");
const port = process.env.PLAYWRIGHT_PORT || "3847";
/** Real-engine qualification is separate from the Chromium responsiveness matrix. */
export default defineConfig({
  testDir: "./e2e", outputDir: "./artifacts/browser-engines", fullyParallel: false, workers: 1,
  retries: 0, forbidOnly: !!process.env.CI, timeout: 120_000, reporter: [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "artifacts/browser-engines/results.json" }]],
  testMatch: ["engine-playback.cases.ts", "live-overload.spec.ts", "transport.spec.ts"],
  grep: /engine qualification:|Repeat wraps Forward 10 and Shift\+Right while an absolute End seek stops|without playbackStats, (?:a 60 ms stall|an 8 ms call)/,
  use: { baseURL: external || `http://127.0.0.1:${port}`, headless: true, trace: "retain-on-failure" },
  projects: [
    { name: "firefox-audio", metadata: { executionTarget: target }, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-audio", metadata: { executionTarget: target }, use: { ...devices["Desktop Safari"] } },
  ],
  ...(external ? {} : { webServer: { command: `exec bash scripts/serve-e2e.sh ${port}`, gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 }, url: `http://127.0.0.1:${port}/build-target-native.json`, reuseExistingServer: false, timeout: 9 * 60_000 } }),
});
