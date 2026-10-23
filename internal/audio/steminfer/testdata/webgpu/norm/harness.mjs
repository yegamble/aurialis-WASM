import { probeGPU, runFixture } from "./client.mjs";
import { parseFixture, shapePlan } from "./contract.mjs";
import { FIXTURE_FILES } from "./fixture-index.mjs";
const output = document.querySelector("pre"), input = document.querySelector("input"), probe = document.querySelector("#probe"), run = document.querySelector("#run"), cancel = document.querySelector("#cancel");
let controller;
const emit = (value) => { output.textContent += JSON.stringify(value) + "\n"; };
async function action(work) {
  if (controller) return;
  controller = new AbortController(); probe.disabled = true; run.disabled = true; cancel.disabled = false;
  try { await work(controller.signal); } catch (error) { emit({ error: String(error.message ?? error), name: error.name }); }
  finally { controller = null; probe.disabled = false; run.disabled = false; cancel.disabled = true; }
}
probe.addEventListener("click", () => { void action(async (signal) => { emit(await probeGPU(signal)); }); });
run.addEventListener("click", () => { void action(async (signal) => {
  if (!input.files?.length || input.files.length > 64) throw new Error("Select one to64 pinned local normalization fixtures");
  for (const file of input.files) {
    signal.throwIfAborted();
    const record = FIXTURE_FILES.find((item) => item.name === file.name);
    if (!record || file.size !== record.bytes) throw new Error("Unpinned normalization fixture name/size");
    const header = new DataView(await file.slice(0, 24).arrayBuffer());
    if (header.byteLength !== 24) throw new Error("Truncated normalization header");
    const plan = shapePlan(header.getUint32(8, true), header.getUint32(12, true));
    if (file.size !== plan.fixtureBytes) throw new Error("Unexpected normalization length");
    const buffer = await file.arrayBuffer();
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (value) => value.toString(16).padStart(2, "0")).join("");
    if (sha !== record.sha256) throw new Error("Selected normalization fixture checksum changed");
    signal.throwIfAborted();
    if (record.admission === "reject-before-worker") {
      try { await runFixture(parseFixture(buffer), signal); } catch (error) {
        if (!String(error.message).includes("overflow")) throw error;
        emit({ fixture: file.name, fixtureSHA256: sha, expectedAdmission: record.admission, rejectedBeforeWorker: true, reason: String(error.message) }); continue;
      }
      throw new Error("Overflow fixture was unexpectedly admitted");
    }
    emit({ fixture: file.name, shape: [plan.rows, plan.width], ...await runFixture(parseFixture(buffer), signal) });
  }
}); });
cancel.addEventListener("click", () => { controller?.abort(); });
