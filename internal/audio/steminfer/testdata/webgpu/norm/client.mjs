/** Private one-shot worker; all fixture references snapshotted before any await. */
import { ABI, SHADER_SHA256, parseFixture, validateOperands, compareFixture } from "./contract.mjs";
import { FIXTURE_SHA256 } from "./fixture-index.mjs";
let active = false;
async function execute(fixture, signal = new AbortController().signal) {
  signal.throwIfAborted();
  if (active) throw new Error("One normalization fixture is already active; there is no queue");
  active = true;
  let worker;
  try {
    if (fixture) { fixture = parseFixture(fixture.view.buffer); validateOperands(fixture); fixture = parseFixture(fixture.view.buffer.slice(0)); }
    worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      let settled = false, canceledError, cleanupDeadline;
      const finish = (error, report) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); clearTimeout(cleanupDeadline); signal.removeEventListener("abort", abort);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
        if (error) reject(error); else resolve(report);
      };
      const cancel = (error) => {
        if (canceledError) return; canceledError = error;
        try { worker.postMessage({ abi: ABI, id, kind: "cancel" }); } catch { finish(error); return; }
        cleanupDeadline = setTimeout(() => { finish(error); }, 50);
      };
      const abort = () => { cancel(signal.reason instanceof Error ? signal.reason : new DOMException("Normalization canceled", "AbortError")); };
      const deadline = setTimeout(() => { cancel(new Error("Normalization fixture exceeded5seconds; prompt GPU preemption is not guaranteed")); }, 5000);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) { abort(); return; }
      worker.onerror = () => { finish(new Error("Normalization worker failed")); };
      worker.onmessageerror = () => { finish(new Error("Normalization result transfer failed")); };
      worker.onmessage = (event) => {
        const data = event.data;
        if (canceledError) { finish(canceledError); return; }
        if (!data || data.abi !== ABI || data.id !== id || !["result", "error"].includes(data.kind)) { finish(new Error("Normalization result identity changed")); return; }
        if (data.kind === "error") { finish(new Error(typeof data.error === "string" ? data.error.slice(0, 1024) : "Normalization failed")); return; }
        try {
          const report = data.report;
          if (!report || report.shaderSHA256 !== SHADER_SHA256) throw new Error("Unpinned normalization report");
          if (fixture) {
            if (!FIXTURE_SHA256.includes(report.fixtureSHA256) || !(report.result instanceof ArrayBuffer) || report.result.byteLength !== fixture.plan.resultBytes
              || report.canariesIntact !== true || report.dispatched !== true || report.passes !== 2 || report.chargedApplicationBufferBytes !== fixture.plan.chargedBytes || report.paddedWork !== fixture.plan.paddedWork) throw new Error("Invalid or unpinned normalization result geometry");
            const comparison = compareFixture(fixture, report.result); delete report.result; finish(null, { ...report, comparison });
          } else if (report.dispatched !== false) throw new Error("Normalization probe unexpectedly dispatched");
          else finish(null, report);
        } catch (error) { finish(error); }
      };
      try {
        const message = { abi: ABI, id, kind: fixture ? "normalize" : "probe" };
        const transfer = [];
        if (fixture) { message.fixture = fixture.view.buffer.slice(0); transfer.push(message.fixture); }
        worker.postMessage(message, transfer);
      } catch (error) { finish(error); }
    });
  } finally { worker?.terminate(); active = false; }
}
export const probeGPU = (signal) => execute(null, signal);
export const runFixture = (fixture, signal) => execute(fixture, signal);
