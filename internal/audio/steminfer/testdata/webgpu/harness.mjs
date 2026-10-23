import { probeGPU, runFixture } from "./client.mjs";
import { parseFixture, shapePlan } from "./contract.mjs";
const output = document.querySelector("pre"), input = document.querySelector("input"), probe = document.querySelector("#probe"), run = document.querySelector("#run"), cancel = document.querySelector("#cancel");
let controller;
const emit = (value) => { output.textContent += JSON.stringify(value, null, 2) + "\n"; };
async function action(work) {
  if (controller) return;
  controller = new AbortController();probe.disabled = true;run.disabled = true;cancel.disabled = false;
  try { await work(controller.signal); } catch (error) { emit({ error: String(error.message ?? error), name: error.name }); }
  finally { controller = null;probe.disabled = false;run.disabled = false;cancel.disabled = true; }
}
probe.addEventListener("click", () => { void action(async (signal) => { emit(await probeGPU(signal)); }); });
run.addEventListener("click", () => { void action(async (signal) => {
  if (!input.files?.length || input.files.length > 70) throw new Error("Select one to seventy local fixture files");
  for (const file of input.files) {
    signal.throwIfAborted();
    // Read the fixed header before allocating the entire fixture/reference file.
    const header = new DataView(await file.slice(0, 24).arrayBuffer());
    if (header.byteLength !== 24) throw new Error("Truncated fixture header");
    const plan = shapePlan(header.getUint32(8, true), header.getUint32(12, true), header.getUint32(16, true));
    if (file.size !== plan.fixtureBytes) throw new Error("Unexpected fixture file length");
    const fixture = parseFixture(await file.arrayBuffer());
    emit({ fixture: file.name.slice(0, 128), shape: [plan.m, plan.n, plan.k], ...await runFixture(fixture, signal) });
  }
}); });
cancel.addEventListener("click", () => { controller?.abort(); });
