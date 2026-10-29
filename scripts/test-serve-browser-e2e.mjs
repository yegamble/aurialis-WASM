import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
const wrapper = path.join(root, "scripts/serve-browser-e2e.sh");
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for owned QA children");
}
async function exists(file) { try { await readFile(file); return true; } catch { return false; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("QA wrapper requires explicit opt-in before starting children", async () => {
  const child = spawn("bash", [wrapper], { env: { ...process.env, AURIALIS_BROWSER_QA: "0" }, stdio: "pipe" });
  let error = ""; child.stderr.on("data", (chunk) => { error += chunk; });
  const [code] = await once(child, "exit"); assert.equal(code, 1); assert.match(error, /AURIALIS_BROWSER_QA=1/u);
});

test("browser global setup requires opt-in before compiling fixtures", async () => {
  const previous = process.env.AURIALIS_BROWSER_QA;
  process.env.AURIALIS_BROWSER_QA = "0";
  try {
    const { default: prepareBrowserTests } = await import("./prepare-browser-tests.mjs");
    await assert.rejects(prepareBrowserTests(), /AURIALIS_BROWSER_QA=1/u);
  } finally {
    if (previous === undefined) delete process.env.AURIALIS_BROWSER_QA;
    else process.env.AURIALIS_BROWSER_QA = previous;
  }
});

test("wrapper terminates its owned child groups and descendants, leaving other processes alone", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aurialis-qa-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"); await mkdir(bin);
  const shim = `#!/usr/bin/env bash
set -eu
name="$(basename "$0")"
printf '%s' "$$" > "$QA_TEST_DIRECTORY/$name.pid"
printf '%s\\n' "$*" > "$QA_TEST_DIRECTORY/$name.args"
sleep 600 &
child=$!
printf '%s' "$child" > "$QA_TEST_DIRECTORY/$name.child"
stop() { kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; printf 'stopped' > "$QA_TEST_DIRECTORY/$name.stopped"; exit 0; }
trap stop TERM INT
wait "$child"
`;
  for (const name of ["pnpm", "node"]) { await writeFile(path.join(bin, name), shim); await chmod(path.join(bin, name), 0o700); }
  // Keep the existing receipt-verification branch active while replacing only
  // the external verifier and server commands with small process fixtures.
  await writeFile(path.join(bin, "python3"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$QA_TEST_DIRECTORY/receipt.args"\n');
  await chmod(path.join(bin, "python3"), 0o700);
  const before = await Promise.all(["scripts/serve-browser.sh", "deploy/cloudflare/worker.ts", "deploy/cloudflare/asset-policy.json"].map((file) => readFile(path.join(root, file)).catch((error) => { if (error.code === "ENOENT") return null; throw error; })));
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { unrelated.kill("SIGKILL"); });
  const child = spawn("bash", [wrapper], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AURIALIS_BROWSER_QA: "1", AURIALIS_USE_CI_BROWSER_ASSETS: "1", QA_TEST_DIRECTORY: directory }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  await until(async () => await exists(path.join(directory, "pnpm.child")) && await exists(path.join(directory, "node.child")));
  const children = await Promise.all(["pnpm.pid", "pnpm.child", "node.pid", "node.child"].map(async (file) => Number(await readFile(path.join(directory, file), "utf8"))));
  assert.match(await readFile(path.join(directory, "receipt.args"), "utf8"), /scripts\/ci-browser-artifacts.py verify/u);
  assert.match(await readFile(path.join(directory, "pnpm.args"), "utf8"), /exec wrangler dev -c deploy\/cloudflare\/wrangler.jsonc --ip 127.0.0.1 --port 3927 --local/u);
  assert.equal((await readFile(path.join(directory, "node.args"), "utf8")).trim(), "scripts/serve-browser-qa.mjs");
  child.kill("SIGTERM"); const [code] = await exited; assert.equal(code, 143);
  await until(() => !children.some(alive));
  assert.equal(await exists(path.join(directory, "node.stopped")), true);
  assert.equal(await exists(path.join(directory, "pnpm.stopped")), true);
  assert.equal(alive(unrelated.pid), true);
  const after = await Promise.all(["scripts/serve-browser.sh", "deploy/cloudflare/worker.ts", "deploy/cloudflare/asset-policy.json"].map((file) => readFile(path.join(root, file)).catch((error) => { if (error.code === "ENOENT") return null; throw error; })));
  assert.deepEqual(after, before);
});

test("browser QA wiring keeps production smoke separate and runs HTTP tests after Node setup", async () => {
  const [config, ci, production, packageJSON] = await Promise.all(["playwright.browser.config.ts", ".github/workflows/ci.yml", "scripts/serve-browser.sh", "package.json"].map((file) => readFile(path.join(root, file), "utf8")));
  assert.match(config, /127\.0\.0\.1:3928/u); assert.match(config, /scripts\/serve-browser-e2e.sh/u);
  assert.match(config, /command: "exec bash scripts\/serve-browser-e2e.sh"/u);
  assert.match(config, /gracefulShutdown: \{ signal: "SIGTERM", timeout: 10_000 \}/u);
  assert.match(ci, /AURIALIS_BROWSER_QA=1 pnpm exec playwright test --config playwright.browser.config.ts/u);
  assert.match(ci, /then port=3928; fi/u); assert.match(ci, /AURIALIS_BROWSER_QA=1 bash scripts\/serve-browser-e2e.sh/u);
  const frontend = ci.slice(ci.indexOf("  frontend-quality:"), ci.indexOf("  browser-build:"));
  assert.ok(frontend.indexOf("node-version: \"26.12.0\"") < frontend.indexOf("node --test scripts/test-serve-browser-qa.mjs scripts/test-serve-browser-e2e.mjs"));
  assert.match(production, /--port 3927 --local/u); assert.doesNotMatch(production, /__qa|serve-browser-qa|serve-browser-e2e/u);
  assert.equal(JSON.parse(packageJSON).scripts["test:browser"], "AURIALIS_BROWSER_QA=1 playwright test --config playwright.browser.config.ts");
});

test("Playwright-owned webServer runs the wrapper cleanup before waiting for inherited pipes", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aurialis-playwright-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"); await mkdir(bin);
  const fixture = path.join(directory, "server.mjs");
  await writeFile(fixture, `import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const label = process.argv[2];
const child = spawn('sleep', ['600'], { stdio: 'inherit' });
writeFileSync(process.env.QA_TEST_DIRECTORY + '/' + label + '.pid', String(process.pid));
writeFileSync(process.env.QA_TEST_DIRECTORY + '/' + label + '.child', String(child.pid));
const server = http.createServer((_request, response) => response.end('real HTTP fixture'));
server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.QA_TEST_DIRECTORY + '/' + label + '.url', 'http://127.0.0.1:' + server.address().port);
  if (label === 'node') console.log('QA lifecycle ready');
});
process.once('SIGTERM', () => {
  child.kill('SIGTERM'); server.closeAllConnections();
  server.close(() => { process.exitCode = 0; });
});
`);
  for (const label of ["pnpm", "node"]) {
    const script = path.join(bin, label);
    await writeFile(script, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fixture}" "${label}"\n`); await chmod(script, 0o700);
  }
  const module = path.join(root, "node_modules/@playwright/test/index.mjs");
  const config = path.join(directory, "playwright.config.ts");
  await writeFile(config, `import base from ${JSON.stringify(path.join(root, "playwright.browser.config.ts"))};
export default { ...base, globalSetup: undefined, testDir: ${JSON.stringify(directory)}, testMatch: /lifecycle.spec.ts/,
  outputDir: ${JSON.stringify(path.join(directory, "results"))}, reporter: 'list', projects: [{ name: 'lifecycle' }],
  webServer: { ...base.webServer, cwd: ${JSON.stringify(root)}, url: undefined, wait: { stdout: /QA lifecycle ready/ }, timeout: 5000,
    env: { AURIALIS_BROWSER_QA: '1', AURIALIS_USE_CI_BROWSER_ASSETS: '0', QA_TEST_DIRECTORY: ${JSON.stringify(directory)}, PATH: ${JSON.stringify(`${bin}:${process.env.PATH}`)} } }
};
`);
  await writeFile(path.join(directory, "lifecycle.spec.ts"), `import { test, expect } from ${JSON.stringify(module)};
import { readFileSync } from 'node:fs';
test('actual HTTP through a Playwright-owned launcher', async ({ request }) => {
  const url = readFileSync(${JSON.stringify(path.join(directory, "node.url"))}, 'utf8');
  expect(await (await request.get(url)).text()).toBe('real HTTP fixture');
});
`);
  t.after(async () => {
    // Failure cleanup targets only process groups created by this test fixture.
    for (const label of ["node", "pnpm"]) {
      try { const pid = Number(await readFile(path.join(directory, `${label}.pid`), "utf8")); process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
  });
  const child = spawn(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"), "test", "--config", config, "--workers=1", "--global-timeout=10000"], {
    cwd: root, env: { ...process.env, AURIALIS_BROWSER_QA: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output); assert.match(output, /1 passed/u);
  for (const label of ["node", "pnpm"]) {
    const pid = Number(await readFile(path.join(directory, `${label}.pid`), "utf8"));
    const descendant = Number(await readFile(path.join(directory, `${label}.child`), "utf8"));
    assert.equal(alive(pid), false, `${label} launcher survived Playwright teardown`);
    assert.equal(alive(descendant), false, `${label} descendant survived Playwright teardown`);
  }
});


test("all owned native launchers preserve their cleanup traps and cold-build budget", async () => {
  for (const file of ["playwright.config.ts", "playwright.engines.config.ts"]) {
    const config = await readFile(path.join(root, file), "utf8");
    assert.match(config, /exec bash scripts\/serve-e2e.sh/u);
    assert.match(config, /gracefulShutdown: \{ signal: "SIGTERM", timeout: 10_000 \}/u);
    assert.match(config, /build-target-native.json/u);
    assert.match(config, /timeout: 9 \* 60_000/u);
  }
});
