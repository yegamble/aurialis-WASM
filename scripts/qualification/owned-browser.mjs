/** Bounded QA-only process admission. No application or audio-request imports. */
import { randomUUID } from "node:crypto";
import fs, { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url), sdkVersion = "1.64.1";

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
function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
async function pinnedSDK() {
  try {
    const testPackage = require.resolve("@playwright/test/package.json"), playwrightPackage = createRequire(testPackage).resolve("playwright/package.json"), corePackage = createRequire(playwrightPackage).resolve("playwright-core/package.json");
    for (const [path, name] of [[testPackage, "@playwright/test"], [playwrightPackage, "playwright"], [corePackage, "playwright-core"]]) {
      const metadata = JSON.parse(await fs.readFile(path, "utf8"));
      if (metadata.name !== name || metadata.version !== sdkVersion) throw new Error("Installed package version differs");
    }
  } catch (cause) { throw new Error("Owned profile requires pinned Playwright SDK 1.64.1", { cause }); }
}
async function privateDirectory(path, identity, empty = false) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) throw new Error("Owned profile directory UID unavailable");
  const valid = (info) => info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(uid) && (info.mode & 0o7777n) === 0o700n;
  const before = await fs.lstat(path, { bigint: true });
  if (!valid(before) || await fs.realpath(path) !== path || (identity && (String(before.dev) !== identity.dev || String(before.ino) !== identity.ino))) throw new Error("Owned profile directory identity, owner, mode or real path mismatch");
  if (empty && (await fs.readdir(path)).length !== 0) throw new Error("Owned profile directory must be initially empty");
  const after = await fs.lstat(path, { bigint: true });
  if (!valid(after) || before.dev !== after.dev || before.ino !== after.ino) throw new Error("Owned profile directory changed during validation");
}
async function profileOptions(acknowledgment, directory, token) {
  if (!Object.hasOwn(acknowledgment, "profile")) return {};
  const profile = acknowledgment.profile;
  if (!closed(acknowledgment, ["token", "nodePID", "parentPID", "phase", "profile"]) || !closed(profile, ["token", "sdkVersion", "userData", "artifacts"]) || profile.token !== token || profile.sdkVersion !== sdkVersion) throw new Error("Invalid owned profile descriptor or SDK");
  const scratch = dirname(directory);
  if (!isAbsolute(directory) || basename(directory) !== "ownership") throw new Error("Owned profile directory requires its exact scratch ownership path");
  for (const [identity, name] of [[profile.userData, "profile"], [profile.artifacts, "browser-artifacts"]]) {
    if (!closed(identity, ["path", "dev", "ino"]) || identity.path !== join(scratch, name) || ![identity.dev, identity.ino].every((value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value))) throw new Error("Invalid owned profile directory descriptor");
  }
  await pinnedSDK();
  await privateDirectory(scratch); await privateDirectory(directory);
  await privateDirectory(profile.userData.path, profile.userData, true); await privateDirectory(profile.artifacts.path, profile.artifacts, true);
  // These explicit SDK paths are retained browser diagnostics, not a promise
  // that an independent failed test context's IndexedDB survives its close.
  return { _userDataDir: profile.userData.path, artifactsDir: profile.artifacts.path };
}
export async function admittedBrowser(chromium, options, stopping = () => false) {
  const { directory, token } = control();
  const acknowledgment = await waitJSON(directory + "/node-ack.json", (value) => value !== null && typeof value === "object" && value.token === token && value.nodePID === process.pid && value.parentPID === process.ppid && value.phase === "node-admitted", stopping);
  const profile = await profileOptions(acknowledgment, directory, token);
  if (stopping()) throw new Error("Ownership launch stopped before browser launch");
  let server;
  try {
    // TERM only sets the caller's flag. It cannot interrupt the returned server
    // handle assignment; any failed/aborted admission still closes that handle.
    server = await chromium.launchServer({ headless: true, host: "127.0.0.1", port: 0, timeout: 15000, ...options, ...profile });
    if (stopping()) throw new Error("Owned browser launch stopped");
    const child = server.process(); if (!Number.isSafeInteger(child.pid)) throw new Error("Missing exact browser process");
    await exclusiveJSON(directory + "/candidate.json", { token, nodePID: process.pid, browserPID: child.pid, browserExecutable: child.spawnfile, ...(Object.hasOwn(acknowledgment, "profile") ? { profile: acknowledgment.profile } : {}) });
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
