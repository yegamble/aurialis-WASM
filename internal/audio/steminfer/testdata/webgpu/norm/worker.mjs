/** Private one-shot original normalization diagnostic. No model or app exports. */
import { ABI, SHADER_SHA256, validateIdentity, validateRequest, validateDevice } from "./contract.mjs";
import { SHADER_SOURCE } from "./shader.mjs";
import { FIXTURE_SHA256 } from "./fixture-index.mjs";
const CANARY = 123456.75;
const LIMIT_NAMES = ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupStorageSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage", "maxBindingsPerBindGroup"];
let accepted = false, canceled = false, requestID = "";
let cancelGPU = () => {};
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
function capability(adapter, device) {
  const info = adapter.info, fields = Object.fromEntries(["vendor", "architecture", "device", "description"].map((key) => [key, typeof info?.[key] === "string" ? info[key].slice(0, 512) : "not exposed"]));
  const reportedFallback = typeof info?.isFallbackAdapter === "boolean" ? info.isFallbackAdapter : typeof adapter.isFallbackAdapter === "boolean" ? adapter.isFallbackAdapter : null;
  const software = reportedFallback === true || /swiftshader|llvmpipe|lavapipe|software|basic render|\bwarp\b/iu.test(Object.values(fields).join(" "));
  return { secureContext: self.isSecureContext, ...fields, reportedFallback,
    hardwareStatus: software ? "software/fallback adapter" : "hardware identity requires independent browser/OS evidence", backend: "not exposed by this WebGPU API",
    adapterFeatures: Array.from(adapter.features).sort(), deviceFeatures: Array.from(device.features).sort(),
    adapterLimits: Object.fromEntries(LIMIT_NAMES.map((name) => [name, adapter.limits[name]])), deviceLimits: Object.fromEntries(LIMIT_NAMES.map((name) => [name, device.limits[name]])) };
}
async function run(message, fixture) {
  const shaderSHA256 = await digest(new TextEncoder().encode(SHADER_SOURCE));
  if (shaderSHA256 !== SHADER_SHA256) throw new Error("Pinned normalization shader changed");
  let fixtureSHA256;
  if (fixture) {
    fixtureSHA256 = await digest(message.fixture);
    if (!FIXTURE_SHA256.includes(fixtureSHA256)) throw new Error("Normalization fixture is not in the pinned actual trace index");
  }
  if (canceled) throw new DOMException("Normalization fixture canceled", "AbortError");
  if (!self.isSecureContext || !navigator.gpu) throw new Error("WebGPU is unavailable in this secure worker");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false });
  if (!adapter) throw new Error("No WebGPU adapter was reported");
  const device = await adapter.requestDevice({ label: "Aurialis private L2 normalization fixture" });
  const buffers = [];
  let disposed = false, mapped = false, scopeCount = 0, readback;
  let rejectDevice;
  const deviceError = new Promise((_, reject) => { rejectDevice = reject; }); void deviceError.catch(() => {});
  const uncaptured = (event) => { rejectDevice(new Error(`GPU error: ${String(event.error?.message ?? "unknown").slice(0, 512)}`)); };
  device.addEventListener("uncapturederror", uncaptured);
  void device.lost.then((reason) => { if (!disposed) rejectDevice(new Error(`GPU device lost: ${String(reason.message).slice(0, 512)}`)); });
  cancelGPU = () => { rejectDevice(new DOMException("Normalization fixture canceled", "AbortError")); for (const buffer of buffers) buffer.destroy(); device.destroy(); };
  const guarded = (promise) => Promise.race([promise, deviceError]);
  const make = (size, usage, label) => { const buffer = device.createBuffer({ size, usage, label }); buffers.push(buffer); return buffer; };
  try {
    if (canceled) throw new DOMException("Normalization fixture canceled", "AbortError");
    const adapterInfo = capability(adapter, device);
    if (!fixture) return { capability: adapterInfo, shaderSHA256, dispatched: false };
    const { plan } = fixture;
    validateDevice(plan, device.limits);
    device.pushErrorScope("out-of-memory"); scopeCount++; device.pushErrorScope("validation"); scopeCount++;
    const shader = device.createShaderModule({ code: SHADER_SOURCE, label: "private two-pass L2*sqrt256" });
    if ((await guarded(shader.getCompilationInfo())).messages.some((item) => item.type === "error")) throw new Error("Normalization shader compilation failed");
    // Explicit one-layout binding set also retains otherwise-unused bindings in
    // each entry point; no automatic-layout differences between the two passes.
    const layout = device.createBindGroupLayout({ entries: [0, 1, 2, 3, 4, 5].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding < 2 ? "read-only-storage" : binding < 5 ? "storage" : "uniform" } })) });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const first = await guarded(device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: shader, entryPoint: "normalize" } }));
    const second = await guarded(device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: shader, entryPoint: "scale" } }));
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const x = make(plan.xBytes + 8, storage, "input and canaries"), gamma = make(plan.gammaBytes + 8, storage, "raw gamma and canaries");
    const quotient = make(plan.xBytes + 8, storage, "stored quotient and canaries"), denominator = make(plan.rows * 4 + 8, storage, "stored denominator and canaries"), output = make(plan.xBytes + 8, storage, "output and canaries");
    const uniform = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "closed normalization parameters");
    readback = make(plan.resultBytes + 24, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, "all stages and canaries");
    const guard = Float32Array.of(CANARY);
    for (const [buffer, data] of [[x, fixture.x], [gamma, fixture.gamma]]) {
      device.queue.writeBuffer(buffer, 0, guard); device.queue.writeBuffer(buffer, data.byteLength + 4, guard); device.queue.writeBuffer(buffer, 4, data);
    }
    for (const [buffer, count] of [[quotient, plan.elements], [denominator, plan.rows], [output, plan.elements]]) {
      const initial = new Float32Array(count + 2); initial.fill(NaN); initial[0] = CANARY; initial[initial.length - 1] = CANARY; device.queue.writeBuffer(buffer, 0, initial);
    }
    device.queue.writeBuffer(uniform, 0, Uint32Array.of(plan.rows, plan.x, 0, 0));
    const bind = device.createBindGroup({ layout, entries: [x, gamma, quotient, denominator, output, uniform].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = device.createCommandEncoder();
    for (const pipeline of [first, second]) { const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(plan.x, plan.y, 1); pass.end(); }
    encoder.copyBufferToBuffer(quotient, 0, readback, 0, plan.xBytes + 8);
    encoder.copyBufferToBuffer(output, 0, readback, plan.xBytes + 8, plan.xBytes + 8);
    encoder.copyBufferToBuffer(denominator, 0, readback, 2 * plan.xBytes + 16, plan.rows * 4 + 8);
    const start = performance.now(); device.queue.submit([encoder.finish()]);
    await guarded(readback.mapAsync(GPUMapMode.READ)); mapped = true;
    const values = new Float32Array(readback.getMappedRange()), result = new Float32Array(plan.resultBytes / 4);
    let sourceOffset = 0, destinationOffset = 0;
    for (const count of [plan.elements, plan.elements, plan.rows]) {
      if (values[sourceOffset] !== CANARY || values[sourceOffset + count + 1] !== CANARY) throw new Error("Normalization stage canary changed");
      const stage = values.subarray(sourceOffset + 1, sourceOffset + count + 1);
      for (const value of stage) if (!Number.isFinite(value)) throw new Error("Normalization produced a nonfinite/unwritten stage");
      result.set(stage, destinationOffset); destinationOffset += count; sourceOffset += count + 2;
    }
    readback.unmap(); mapped = false;
    while (scopeCount > 0) { scopeCount--; const error = await guarded(device.popErrorScope()); if (error) throw new Error(`GPU scoped error: ${String(error.message).slice(0, 512)}`); }
    return { capability: adapterInfo, shaderSHA256, fixtureSHA256, dispatched: true, result: result.buffer, canariesIntact: true,
      chargedApplicationBufferBytes: plan.chargedBytes, createdGPUBufferBytes: buffers.reduce((sum, item) => sum + item.size, 0), paddedWork: plan.paddedWork,
      passes: 2, submitToReadbackMilliseconds: performance.now() - start, timingScope: "one cold two-pass atomic fixture, not a model/deadline benchmark; per-pass GPU timestamps unavailable without an extra feature" };
  } finally {
    disposed = true; cancelGPU = () => {};
    if (mapped) readback?.unmap(); for (const buffer of buffers) buffer.destroy();
    for (; scopeCount > 0; scopeCount--) { try { await device.popErrorScope(); } catch {} }
    device.removeEventListener("uncapturederror", uncaptured); device.destroy();
  }
}
self.onmessage = (event) => {
  const message = event.data;
  if (accepted) { if (message?.abi === ABI && message.id === requestID && message.kind === "cancel" && Object.keys(message).sort().join("|") === "abi|id|kind") { canceled = true; cancelGPU(); } return; }
  accepted = true; requestID = typeof message?.id === "string" ? message.id : "";
  void (async () => { validateIdentity(message); const fixture = validateRequest(message); const report = await run(message, fixture); self.postMessage({ abi: ABI, id: message.id, kind: "result", report }, report.result ? [report.result] : []); })()
    .catch((error) => { self.postMessage({ abi: ABI, id: typeof message?.id === "string" ? message.id.slice(0, 64) : "invalid", kind: "error", error: String(error.message ?? error).slice(0, 1024) }); }).finally(() => { self.close(); });
};
