/** Launch one acknowledged BrowserServer before any Playwright page can start work. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { admittedBrowser, beforeOwnedWork, exclusiveJSON } from "./owned-browser.mjs";
const require = createRequire(import.meta.url), { chromium } = require("@playwright/test");
const [mode, project, output] = process.argv.slice(2);
if (!["scale", "normal", "crash"].includes(mode) || !output || (mode === "scale" && !["album-native-scale", "album-browser-scale"].includes(project))) throw new Error("Closed qualification mode required");
function errorView(error) { return error instanceof AggregateError ? { message: error.message, causes: error.errors.slice(0, 4).map((cause) => String(cause?.stack ?? cause).slice(0, 4096)) } : String(error?.stack ?? error).slice(0, 4096); }
let server, browser, context, child, primary, childExit = null, stopping = false;
const cleanup = [];
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
try {
  server = await admittedBrowser(chromium, process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}, () => stopping);
  if (stopping) throw new Error("Owned root stopped after browser admission");
  if (mode === "scale") {
    child = spawn(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", "playwright.album-scale.config.ts", "--project", project], { stdio: "inherit", env: { ...process.env, AURIALIS_OWNED_BROWSER_WS: server.wsEndpoint() } });
    childExit = await new Promise((resolve, reject) => {
      let stopAt = null;
      const timer = setInterval(() => { if (stopping && stopAt === null) { stopAt = Date.now(); child.kill("SIGTERM"); } else if (stopAt !== null && Date.now() - stopAt > 5000) child.kill("SIGKILL"); }, 25);
      child.once("error", (error) => { clearInterval(timer); reject(error); }); child.once("exit", (code, signal) => { clearInterval(timer); resolve({ code, signal }); });
    });
    if (childExit.code !== 0 || childExit.signal !== null) throw new Error("Scale test child did not exit successfully");
  } else {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 15000 }); context = await browser.newContext(); const page = await context.newPage(); await page.goto("about:blank"); await beforeOwnedWork(() => stopping);
    const result = await page.evaluate(() => new Promise((resolve, reject) => { const url = URL.createObjectURL(new Blob(["postMessage(1)"], { type: "application/javascript" })), worker = new Worker(url), deadline = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error("No-audio ownership probe deadline")); }, 5000); worker.onmessage = (event) => { clearTimeout(deadline); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); }; worker.onerror = () => { clearTimeout(deadline); worker.terminate(); URL.revokeObjectURL(url); reject(new Error("No-audio probe worker failed")); }; }));
    assert.equal(result, 1); await exclusiveJSON(output + "/probe-ready.json", { token: process.env.AURIALIS_OWNERSHIP_TOKEN, status: "pass", mode, ownershipAcknowledgedBeforeWorker: true, browserVersion: browser.version(), audioProcessing: false, nodePID: process.pid, browserPID: server.process().pid });
    if (mode === "crash") while (!stopping) await new Promise((resolve) => setTimeout(resolve, 25));
    if (stopping) throw new Error("Owned no-audio root stopped");
  }
} catch (error) { primary = errorView(error); process.exitCode = 1; }
finally {
  for (const [phase, target] of [["context", context], ["connection", browser], ["server", server]]) {
    try { await target?.close(); } catch (error) { cleanup.push({ phase, error: String(error).slice(0, 1024) }); process.exitCode = 1; }
  }
  await writeFile(output + "/launcher.json", JSON.stringify({ mode, project, primary: primary ?? null, cleanup: cleanup ?? null, childExit, audioProcessing: mode === "scale" }, null, 2));
}
