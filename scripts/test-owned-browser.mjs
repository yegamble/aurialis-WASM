import assert from "node:assert/strict";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { mock } from "node:test";
import { admittedBrowser, exclusiveJSON } from "./qualification/owned-browser.mjs";
import "./test-album-download.mjs";

async function fixture(body) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "aurialis-owned-browser-unit-"))), directory = join(scratch, "ownership"), token = "a".repeat(64);
  await mkdir(directory, { mode: 0o700 });
  const keys = ["AURIALIS_OWNERSHIP_DIR", "AURIALIS_OWNERSHIP_TOKEN", "AURIALIS_OWNED_NODE_PID", "AURIALIS_OWNED_BROWSER_PID"], previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.AURIALIS_OWNERSHIP_DIR = directory; process.env.AURIALIS_OWNERSHIP_TOKEN = token;
  try { await body({ directory, token }); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(scratch, { recursive: true }); }
}
async function acknowledge(directory, token, extra = {}) { await exclusiveJSON(join(directory, "node-ack.json"), { token, nodePID: process.pid, parentPID: process.ppid, phase: "node-admitted", ...extra }); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check) { const end = Date.now() + 1000; while (!(await check())) { assert.ok(Date.now() < end, "Synthetic admission wait exceeded one second"); await new Promise((resolve) => setTimeout(resolve, 5)); } }
async function profileDescriptor(directory, token) {
  const identities = {};
  for (const [key, name] of [["userData", "profile"], ["artifacts", "browser-artifacts"]]) {
    const path = join(dirname(directory), name); await mkdir(path, { mode: 0o700 });
    const info = await lstat(path, { bigint: true }); identities[key] = { path, dev: String(info.dev), ino: String(info.ino) };
  }
  return { token, sdkVersion: "1.64.1", ...identities };
}
async function browserAcknowledgment(directory, token) {
  await until(async () => { try { return JSON.parse(await readFile(join(directory, "candidate.json"), "utf8")).browserPID === 54321; } catch (error) { if (error.code !== "ENOENT") throw error; return false; } });
  await exclusiveJSON(join(directory, "ack.json"), { token, nodePID: process.pid, parentPID: process.ppid, browserPID: 54321, browserPGID: 54321, browserStart: "synthetic-start" });
}
function syntheticServer(close = async () => {}) { return { process: () => ({ pid: 54321, spawnfile: "/synthetic/no-browser" }), close }; }

test("synthetic stopped startup cannot launch any browser before parent acknowledgment", async () => {
  await fixture(async () => { let launches = 0; await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}, () => true), /stopped before acknowledgment/u); assert.equal(launches, 0); });
});
test("synthetic stop during launch retains the returned handle until its actual close settles", async () => {
  await fixture(async ({ directory, token }) => {
    await acknowledge(directory, token); const launch = deferred(), closed = deferred(); let stopping = false, closes = 0, settled = false, launched = false;
    const result = admittedBrowser({ launchServer: () => { launched = true; return launch.promise; } }, {}, () => stopping).finally(() => { settled = true; }); const rejected = assert.rejects(result, /launch stopped/u);
    await until(() => launched); stopping = true; launch.resolve({ close() { closes++; return closed.promise; } });
    await until(() => closes === 1); assert.equal(settled, false); closed.resolve(); await rejected; assert.equal(settled, true);
  });
});
test("synthetic wrong browser acknowledgment closes its exact server before rejecting", async () => {
  await fixture(async ({ directory, token }) => {
    await acknowledge(directory, token, { profile: await profileDescriptor(directory, token) }); const closed = deferred(); let closes = 0, settled = false;
    const result = admittedBrowser({ launchServer: async () => ({ process: () => ({ pid: 54321, spawnfile: "/synthetic/no-browser" }), close() { closes++; return closed.promise; } }) }, {}).finally(() => { settled = true; }); const rejected = assert.rejects(result, /identity mismatch/u);
    await until(async () => { try { return JSON.parse(await readFile(join(directory, "candidate.json"), "utf8")).browserPID === 54321; } catch (error) { if (error.code !== "ENOENT") throw error; return false; } });
    await exclusiveJSON(join(directory, "ack.json"), { token: "b".repeat(64) }); await until(() => closes === 1); assert.equal(settled, false); closed.resolve(); await rejected;
  });
});

test("strict profile descriptor rejects closed-schema, token, path and identity violations before launch", async (parent) => {
  const cases = [
    ["null descriptor", (profile) => { return null; }],
    ["descriptor extra field", (profile) => ({ ...profile, ignored: true })],
    ["descriptor wrong token", (profile) => ({ ...profile, token: "b".repeat(64) })],
    ["descriptor wrong SDK", (profile) => ({ ...profile, sdkVersion: "1.64.0" })],
    ["path extra field", (profile) => ({ ...profile, userData: { ...profile.userData, ignored: true } })],
    ["wrong derived path", (profile) => ({ ...profile, userData: { ...profile.userData, path: profile.artifacts.path } })],
    ["relative path", (profile) => ({ ...profile, artifacts: { ...profile.artifacts, path: "browser-artifacts" } })],
    ["numeric device", (profile) => ({ ...profile, userData: { ...profile.userData, dev: 1 } })],
    ["noncanonical inode", (profile) => ({ ...profile, userData: { ...profile.userData, ino: "0" + profile.userData.ino } })],
    ["wrong device", (profile) => ({ ...profile, artifacts: { ...profile.artifacts, dev: String(BigInt(profile.artifacts.dev) + 1n) } })],
    ["wrong inode", (profile) => ({ ...profile, userData: { ...profile.userData, ino: String(BigInt(profile.userData.ino) + 1n) } })],
  ];
  for (const [label, change] of cases) await parent.test(label, async () => {
    await fixture(async ({ directory, token }) => {
      const profile = change(await profileDescriptor(directory, token)); await acknowledge(directory, token, { profile }); let launches = 0;
      await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}), /profile|directory|SDK/iu); assert.equal(launches, 0);
    });
  });
});

test("strict parent acknowledgment rejects wrong identities and unexpected fields before launch", async (parent) => {
  for (const [label, change] of [["token", { token: "b".repeat(64) }], ["Node PID", { nodePID: process.pid + 1 }], ["parent PID", { parentPID: process.ppid + 1 }], ["phase", { phase: "later" }], ["extra field", { ignored: true }]]) await parent.test(label, async () => {
    await fixture(async ({ directory, token }) => {
      await acknowledge(directory, token, { profile: await profileDescriptor(directory, token), ...change }); let launches = 0;
      await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}), /identity mismatch|profile/iu); assert.equal(launches, 0);
    });
  });
});

test("strict profile rejects stale, nonempty, symlink, foreign-owner and broad-mode directories before launch", async (parent) => {
  const cases = [
    ["stale inode", async (profile) => { await rename(profile.userData.path, profile.userData.path + "-old"); await mkdir(profile.userData.path, { mode: 0o700 }); }],
    ["nonempty profile", async (profile) => { await writeFile(join(profile.userData.path, "prior-evidence"), "retain"); }],
    ["nonempty artifacts", async (profile) => { await writeFile(join(profile.artifacts.path, "prior-evidence"), "retain"); }],
    ["symlink profile", async (profile) => { await rename(profile.userData.path, profile.userData.path + "-old"); await symlink(profile.userData.path + "-old", profile.userData.path); }],
    ["symlink scratch", async (profile, directory) => { const scratch = dirname(directory); await symlink(scratch, scratch + "-alias"); process.env.AURIALIS_OWNERSHIP_DIR = join(scratch + "-alias", "ownership"); return async () => { await rm(scratch + "-alias"); }; }],
    ["foreign owner", async (profile) => { const original = fs.lstat; const mocked = mock.method(fs, "lstat", async (path, options) => { const info = await original(path, options); return path === profile.userData.path ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: info.uid + 1n }) : info; }); return () => { mocked.mock.restore(); }; }],
    ["broad mode", async (profile) => { await chmod(profile.artifacts.path, 0o755); }],
  ];
  for (const [label, change] of cases) await parent.test(label, async () => {
    await fixture(async ({ directory, token }) => {
      const profile = await profileDescriptor(directory, token); await acknowledge(directory, token, { profile }); const restore = await change(profile, directory); let launches = 0;
      try { await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}), /profile|directory/iu); assert.equal(launches, 0); }
      finally { await restore?.(); }
    });
  });
});

test("strict profile requires the actual installed pinned SDK before launch", async () => {
  await fixture(async ({ directory, token }) => {
    await acknowledge(directory, token, { profile: await profileDescriptor(directory, token) }); let launches = 0;
    const original = fs.readFile, mocked = mock.method(fs, "readFile", async (path, ...options) => {
      const content = await original(path, ...options);
      return String(path).includes("playwright-core/package.json") ? JSON.stringify({ ...JSON.parse(content), version: "1.64.0" }) : content;
    });
    try { await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}), /SDK/iu); assert.equal(launches, 0); }
    finally { mocked.mock.restore(); }
  });
});

test("strict profile overrides caller paths and retains exact directories after successful close", async () => {
  await fixture(async ({ directory, token }) => {
    const profile = await profileDescriptor(directory, token); await acknowledge(directory, token, { profile }); let launched, closes = 0;
    const acknowledged = browserAcknowledgment(directory, token), server = syntheticServer(async () => { closes++; });
    const returned = await admittedBrowser({ async launchServer(options) { launched = options; return server; } }, { _userDataDir: "/unowned", artifactsDir: "/unowned-artifacts", executablePath: "/synthetic/chromium" }); await acknowledged;
    assert.equal(returned, server); assert.equal(launched._userDataDir, profile.userData.path); assert.equal(launched.artifactsDir, profile.artifacts.path); assert.equal(launched.executablePath, "/synthetic/chromium");
    await returned.close(); assert.equal(closes, 1);
    for (const identity of [profile.userData, profile.artifacts]) { const info = await lstat(identity.path, { bigint: true }); assert.equal(String(info.dev), identity.dev); assert.equal(String(info.ino), identity.ino); }
  });
});

test("strict partial launch failure retains directories without inventing a returned handle", async () => {
  await fixture(async ({ directory, token }) => {
    const profile = await profileDescriptor(directory, token); await acknowledge(directory, token, { profile }); const primary = new Error("Synthetic partial launch failure");
    await assert.rejects(admittedBrowser({ async launchServer(options) { await writeFile(join(options._userDataDir, "diagnostic"), "retain"); throw primary; } }, {}), (error) => error === primary);
    assert.equal(await readFile(join(profile.userData.path, "diagnostic"), "utf8"), "retain"); assert.ok((await lstat(profile.artifacts.path)).isDirectory());
  });
});

test("strict stopped launch awaits held close and retains both primary and cleanup errors", async () => {
  await fixture(async ({ directory, token }) => {
    const profile = await profileDescriptor(directory, token); await acknowledge(directory, token, { profile }); const launch = deferred(), closed = deferred(), cleanup = new Error("Synthetic close failure"); let stopping = false, closes = 0, settled = false, launched = false;
    const result = admittedBrowser({ launchServer: () => { launched = true; return launch.promise; } }, {}, () => stopping).finally(() => { settled = true; }); const rejected = assert.rejects(result, (error) => error instanceof AggregateError && /launch stopped/u.test(error.errors[0].message) && error.errors[1] === cleanup);
    await until(() => launched); stopping = true; launch.resolve(syntheticServer(async () => { closes++; await closed.promise; throw cleanup; }));
    await until(() => closes === 1); assert.equal(settled, false); closed.resolve(); await rejected; assert.equal(settled, true); assert.ok((await lstat(profile.userData.path)).isDirectory());
  });
});
