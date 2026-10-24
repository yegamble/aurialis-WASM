/** Bounded QA-only process admission. No application or audio-request imports. */
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";

export async function exclusiveJSON(path, value) {
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 4096) throw new Error("Ownership metadata exceeds its bound");
  const temporary = path + ".writing"; await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await link(temporary, path); await unlink(temporary);
}
async function waitJSON(path, accepts, stopping = () => false) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (stopping()) throw new Error("Ownership launch stopped before acknowledgment");
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4096) throw new Error("Invalid ownership acknowledgment"); const value = JSON.parse(await readFile(path, "utf8")); if (!accepts(value)) throw new Error("Ownership acknowledgment identity mismatch"); return value; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Ownership acknowledgment deadline");
}
function control() {
  const directory = process.env.AURIALIS_OWNERSHIP_DIR, token = process.env.AURIALIS_OWNERSHIP_TOKEN;
  if (!directory || !/^[a-f0-9]{64}$/u.test(token ?? "")) throw new Error("Missing private ownership contract");
  return { directory, token };
}
export async function admittedBrowser(chromium, options, stopping = () => false) {
  const { directory, token } = control();
  await waitJSON(directory + "/node-ack.json", (value) => value.token === token && value.nodePID === process.pid && value.parentPID === process.ppid && value.phase === "node-admitted", stopping);
  let server;
  try {
    // TERM only sets the caller's flag. It cannot interrupt the returned server
    // handle assignment; any failed/aborted admission still closes that handle.
    server = await chromium.launchServer({ headless: true, host: "127.0.0.1", port: 0, timeout: 15000, ...options });
    if (stopping()) throw new Error("Owned browser launch stopped");
    const child = server.process(); if (!Number.isSafeInteger(child.pid)) throw new Error("Missing exact browser process");
    await exclusiveJSON(directory + "/candidate.json", { token, nodePID: process.pid, browserPID: child.pid, browserExecutable: child.spawnfile });
    await waitJSON(directory + "/ack.json", (value) => value.token === token && value.nodePID === process.pid && value.parentPID === process.ppid && value.browserPID === child.pid && value.browserPGID === child.pid && typeof value.browserStart === "string", stopping);
    process.env.AURIALIS_OWNED_NODE_PID = String(process.pid); process.env.AURIALIS_OWNED_BROWSER_PID = String(child.pid);
    return server;
  } catch (primary) {
    if (server) {
      try { await server.close(); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned browser admission and cleanup failed"); }
    }
    throw primary;
  }
}
export async function beforeOwnedWork(stopping = () => false) {
  const { directory, token } = control(), nodePID = Number(process.env.AURIALIS_OWNED_NODE_PID), browserPID = Number(process.env.AURIALIS_OWNED_BROWSER_PID), id = randomUUID();
  if (!Number.isSafeInteger(nodePID) || !Number.isSafeInteger(browserPID)) throw new Error("Missing acknowledged browser ownership");
  const request = { token, nodePID, browserPID, workerPID: process.pid, phase: "before-worker", id };
  await exclusiveJSON(`${directory}/before-worker-${id}.json`, request);
  await waitJSON(`${directory}/before-worker-${id}-ack.json`, (value) => Object.keys(request).every((key) => value[key] === request[key]), stopping);
}
