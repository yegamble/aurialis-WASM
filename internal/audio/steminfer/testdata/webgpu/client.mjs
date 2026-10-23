/** Private one-shot fixture worker. A timeout releases ownership, not a GPU preemption promise. */
import { ABI, validateOperands, compareFixture, SHADER_SHA256, parseFixture } from "./contract.mjs";
let active = false;
const DEADLINE_MS = 5000;
async function execute(fixture, signal = new AbortController().signal) {
  signal.throwIfAborted();
  if (active) throw new Error("One private GPU fixture is already active; there is no queue");
  if (fixture) { fixture = parseFixture(fixture.view.buffer); validateOperands(fixture.plan, fixture.a, fixture.b); }
  active = true;
  let worker;
  try {
    // The caller never receives this private comparison snapshot. Charge it in
    // shapePlan before copying; compare against exactly the transferred inputs.
    if (fixture) fixture = parseFixture(fixture.view.buffer.slice(0));
    // Literal same-origin module. No supplied worker/shader URL or model fetch.
    worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      let settled = false, canceledError, cancelDeadline;
      const finish = (error, report) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); clearTimeout(cancelDeadline); signal.removeEventListener("abort", abort);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
        if (error) reject(error); else resolve(report);
      };
      const cancel = (error) => {
        if (canceledError) return;
        canceledError = error;
        try { worker.postMessage({ abi: ABI, id, kind: "cancel" }); }
        catch { finish(error); return; }
        // Allow explicit destroy/cleanup on the worker, then hard-terminate it.
        // Neither action certifies prompt driver/GPU preemption.
        cancelDeadline = setTimeout(() => { finish(error); }, 50);
      };
      const abort = () => { cancel(signal.reason instanceof Error ? signal.reason : new DOMException("Private GPU fixture canceled", "AbortError")); };
      const deadline = setTimeout(() => { cancel(new Error("Private GPU fixture exceeded its 5-second deadline; prompt GPU preemption is not guaranteed")); }, DEADLINE_MS);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      worker.onerror = () => { finish(new Error("Private GPU worker failed")); };
      worker.onmessageerror = () => { finish(new Error("Private GPU result could not be transferred")); };
      worker.onmessage = (event) => {
        const data = event.data;
        if (canceledError) { finish(canceledError); return; }
        if (!data || data.abi !== ABI || data.id !== id || !["result", "error"].includes(data.kind)) { finish(new Error("Private GPU result identity changed")); return; }
        if (data.kind === "error") { finish(new Error(typeof data.error === "string" ? data.error.slice(0, 1024) : "Private GPU fixture failed")); return; }
        try {
          if (!data.report || typeof data.report !== "object" || data.report.shaderSHA256 !== SHADER_SHA256) throw new Error("Missing or unpinned private GPU report");
          if (fixture) {
            if (!(data.report.result instanceof ArrayBuffer) || data.report.result.byteLength !== fixture.plan.cBytes || data.report.canariesIntact !== true || data.report.dispatched !== true || data.report.chargedApplicationBufferBytes !== fixture.plan.chargedBytes || data.report.paddedMultiplyAdds !== fixture.plan.paddedWork) throw new Error("Invalid private GPU result geometry");
            const comparison = compareFixture(fixture, new Float32Array(data.report.result));
            delete data.report.result;
            finish(null, { ...data.report, comparison });
          } else if (data.report.dispatched !== false) throw new Error("Capability probe unexpectedly dispatched");
          else finish(null, data.report);
        } catch (error) { finish(error); }
      };
      try {
      const message = { abi: ABI, id, kind: fixture ? "matmul" : "probe" };
      const transfer = [];
      if (fixture) {
        message.m = fixture.plan.m; message.n = fixture.plan.n; message.k = fixture.plan.k;
        message.a = fixture.a.slice().buffer; message.b = fixture.b.slice().buffer; transfer.push(message.a, message.b);
      }
      worker.postMessage(message, transfer);
      } catch (error) { finish(error); }
    });
  } finally { worker?.terminate(); active = false; }
}
export const probeGPU = (signal) => execute(null, signal);
export const runFixture = (fixture, signal) => execute(fixture, signal);
