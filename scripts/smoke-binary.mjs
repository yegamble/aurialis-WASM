import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Launch from an empty directory: assets must come from the executable.
const directory = await mkdtemp(path.join(tmpdir(), "aurialis-smoke-"));
const binary = path.resolve("aurialis");
const port = 39871;
const host = `http://127.0.0.1:${port}`;
const liveExports = ["aurialis_live_buffer", "aurialis_live_process", "aurialis_live_reset", "aurialis_live_end_input", "aurialis_live_resume_input", "aurialis_live_tail_buffer", "aurialis_live_tail_frames"];
const child = spawn(binary, ["-addr", `127.0.0.1:${port}`], {
  cwd: directory,
  stdio: ["ignore", "ignore", "inherit"],
});
let failure;
child.once("error", (error) => { failure = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Binary exited ${child.exitCode}`);
    try { ready = (await fetch(`${host}/health`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "binary did not become ready");
  for (const route of ["/", "/library", "/master/uploaded-project", "/wasm/wasm_exec.js", "/wasm/aurialis-dsp.wasm", "/wasm/aurialis-realtime.wasm", "/worklets/aurialis-live-worklet.js", "/worklets/aurialis-wasi-host.js"]) {
    const response = await fetch(`${host}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    if (route.endsWith(".wasm")) {
      assert.equal(response.headers.get("content-type"), "application/wasm");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0, 97, 115, 109]);
      const exports = WebAssembly.Module.exports(await WebAssembly.compile(bytes));
      const realtime = route.endsWith("aurialis-realtime.wasm");
      // The production JS module exposes Go runtime entry points; its offline
      // dispatcher is a JS global exercised by test:wasm. Direct live exports
      // belong only to the WASI reactor and the separately tagged QA probe.
      const required = realtime ? [...liveExports, "_initialize", "aurialis_init", "aurialis_control_buffer", "aurialis_set_controls",
        "aurialis_set_monitor_mode", "aurialis_monitor_buffer", "aurialis_monitor_process"] : ["run", "resume", "getsp"];
      for (const name of required)
        assert.ok(exports.some(item => item.name === name && item.kind === "function"), `embedded WASM is missing ${name}`);
      if (!realtime) for (const name of liveExports)
        assert.ok(!exports.some(item => item.name === name), `production offline WASM contains the legacy live export ${name}`);
      assert.ok(exports.some(item => item.name === (realtime ? "memory" : "mem") && item.kind === "memory"), "embedded WASM memory is missing");
    } else {
      const source = await response.text();
      assert.ok(source.length > 100, `${route} is empty`);
      if (route.endsWith("aurialis-live-worklet.js")) {
        assert.ok(source.includes('registerProcessor("aurialis-live"'), "embedded audio worklet is missing");
        for (const name of liveExports) assert.ok(source.includes(name), `embedded audio worklet is missing ${name}`);
      }
      if (route.endsWith("aurialis-wasi-host.js")) assert.ok(source.includes("createAurialisWasiHost"), "embedded initialization host is missing");
    }
  }
  assert.equal((await fetch(`${host}/__qa/actual-output-tap.js`)).status, 404, "production binary must exclude QA instrumentation");
  console.log("Compiled binary serves embedded UI, both WASM targets, worklet and initialization host from an empty directory.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null || failure) resolve();
    else child.once("exit", resolve);
  });
  await rm(directory, { recursive: true, force: true });
}
