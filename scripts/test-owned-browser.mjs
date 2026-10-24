import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admittedBrowser, exclusiveJSON } from "./qualification/owned-browser.mjs";

async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), "aurialis-owned-browser-unit-")), token = "a".repeat(64);
  const previous = { directory: process.env.AURIALIS_OWNERSHIP_DIR, token: process.env.AURIALIS_OWNERSHIP_TOKEN };
  process.env.AURIALIS_OWNERSHIP_DIR = directory; process.env.AURIALIS_OWNERSHIP_TOKEN = token;
  try { await body({ directory, token }); }
  finally { if (previous.directory === undefined) delete process.env.AURIALIS_OWNERSHIP_DIR; else process.env.AURIALIS_OWNERSHIP_DIR = previous.directory; if (previous.token === undefined) delete process.env.AURIALIS_OWNERSHIP_TOKEN; else process.env.AURIALIS_OWNERSHIP_TOKEN = previous.token; await rm(directory, { recursive: true }); }
}
async function acknowledge(directory, token) { await exclusiveJSON(join(directory, "node-ack.json"), { token, nodePID: process.pid, parentPID: process.ppid, phase: "node-admitted" }); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check) { const end = Date.now() + 1000; while (!(await check())) { assert.ok(Date.now() < end, "Synthetic admission wait exceeded one second"); await new Promise((resolve) => setTimeout(resolve, 5)); } }

test("synthetic stopped startup cannot launch any browser before parent acknowledgment", async () => {
  await fixture(async () => { let launches = 0; await assert.rejects(admittedBrowser({ launchServer() { launches++; throw new Error("Unexpected launch"); } }, {}, () => true), /stopped before acknowledgment/u); assert.equal(launches, 0); });
});
test("synthetic stop during launch retains the returned handle until its actual close settles", async () => {
  await fixture(async ({ directory, token }) => {
    await acknowledge(directory, token); const launch = deferred(), closed = deferred(); let stopping = false, closes = 0, settled = false;
    const result = admittedBrowser({ launchServer: () => launch.promise }, {}, () => stopping).finally(() => { settled = true; }); const rejected = assert.rejects(result, /launch stopped/u);
    await new Promise((resolve) => setTimeout(resolve, 10)); stopping = true; launch.resolve({ close() { closes++; return closed.promise; } });
    await until(() => closes === 1); assert.equal(settled, false); closed.resolve(); await rejected; assert.equal(settled, true);
  });
});
test("synthetic wrong browser acknowledgment closes its exact server before rejecting", async () => {
  await fixture(async ({ directory, token }) => {
    await acknowledge(directory, token); const closed = deferred(); let closes = 0, settled = false;
    const result = admittedBrowser({ launchServer: async () => ({ process: () => ({ pid: 54321, spawnfile: "/synthetic/no-browser" }), close() { closes++; return closed.promise; } }) }, {}).finally(() => { settled = true; }); const rejected = assert.rejects(result, /identity mismatch/u);
    await until(async () => { try { return JSON.parse(await readFile(join(directory, "candidate.json"), "utf8")).browserPID === 54321; } catch (error) { if (error.code !== "ENOENT") throw error; return false; } });
    await exclusiveJSON(join(directory, "ack.json"), { token: "b".repeat(64) }); await until(() => closes === 1); assert.equal(settled, false); closed.resolve(); await rejected;
  });
});
