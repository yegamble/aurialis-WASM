/** Development-only one-shot worker. Shader module is generated from pinned bytes. */
import { ABI, validateIdentity, validateRequest, validateDevice, SHADER_SHA256 } from "./contract.mjs";
import { SHADER_SOURCE } from "./shader.mjs";
const LIMIT_NAMES = ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupStorageSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage", "maxBindingsPerBindGroup", "minUniformBufferOffsetAlignment"];
const CANARY = 123456.75;
let accepted = false, canceled = false, requestID = "";
let cancelGPU = () => {};
function limits(value) { return Object.fromEntries(LIMIT_NAMES.map((name) => [name, value[name]])); }
function adapterReport(adapter, device) {
  const info = adapter.info;
  const fields = Object.fromEntries(["vendor", "architecture", "device", "description"].map((key) => [key, typeof info?.[key] === "string" ? info[key].slice(0, 512) : "not exposed"]));
  const reportedFallback = typeof info?.isFallbackAdapter === "boolean" ? info.isFallbackAdapter : typeof adapter.isFallbackAdapter === "boolean" ? adapter.isFallbackAdapter : null;
  const software = reportedFallback === true || /swiftshader|llvmpipe|lavapipe|software|basic render|\bwarp\b/iu.test(Object.values(fields).join(" "));
  return { secureContext: self.isSecureContext, ...fields, reportedFallback, hardwareStatus: software ? "software/fallback adapter" : "hardware identity requires independent browser/OS evidence",
    backend: "not exposed by this WebGPU API", adapterFeatures: Array.from(adapter.features).sort(), deviceFeatures: Array.from(device.features).sort(), adapterLimits: limits(adapter.limits), deviceLimits: limits(device.limits) };
}
async function run(message, plan) {
  if (!self.isSecureContext || !navigator.gpu) throw new Error("WebGPU is unavailable in this secure worker");
  const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SHADER_SOURCE))), (x) => x.toString(16).padStart(2, "0")).join("");
  if (sourceHash !== SHADER_SHA256) throw new Error("Pinned shader source changed");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false });
  if (!adapter) throw new Error("No WebGPU adapter was reported");
  const device = await adapter.requestDevice({ label: "Aurialis private scalar GEMM fixture" });
  const buffers = [];
  let disposed = false, mapped = false, scopeCount = 0;
  let rejectDevice;
  const deviceError = new Promise((_, reject) => { rejectDevice = reject; });
  void deviceError.catch(() => {});
  const uncaptured = (event) => { rejectDevice(new Error(`GPU error: ${String(event.error?.message ?? "unknown").slice(0, 512)}`)); };
  device.addEventListener("uncapturederror", uncaptured);
  void device.lost.then((reason) => { if (!disposed) rejectDevice(new Error(`GPU device lost: ${String(reason.message).slice(0, 512)}`)); });
  cancelGPU = () => {
    rejectDevice(new DOMException("Private GPU fixture canceled", "AbortError"));
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  };
  const guarded = (promise) => Promise.race([promise, deviceError]);
  const make = (size, usage, label) => { const buffer = device.createBuffer({ size, usage, label }); buffers.push(buffer); return buffer; };
  try {
    if (canceled) throw new DOMException("Private GPU fixture canceled", "AbortError");
    const capability = adapterReport(adapter, device);
    if (!plan) return { capability, shaderSHA256: sourceHash, dispatched: false };
    validateDevice(plan, device.limits);
    device.pushErrorScope("out-of-memory"); scopeCount++;
    device.pushErrorScope("validation"); scopeCount++;
    const shader = device.createShaderModule({ code: SHADER_SOURCE, label: "pinned s64" });
    const compilation = await guarded(shader.getCompilationInfo());
    if (compilation.messages.some((entry) => entry.type === "error")) throw new Error("Pinned shader compilation failed");
    const pipeline = await guarded(device.createComputePipelineAsync({ layout: "auto", compute: { module: shader, entryPoint: "main" } }));
    const a = make(plan.aBytes + 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "A and canaries");
    const b = make(plan.bBytes + 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "B and canaries");
    const c = make(plan.cBytes + 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, "C and canaries");
    const bias = make(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "unreachable bias");
    const uniform = make(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "closed s64 parameters");
    const readback = make(plan.cBytes + 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, "bounded readback");
    const guard = Float32Array.of(CANARY);
    for (const [buffer, bytes, data] of [[a, plan.aBytes, message.a], [b, plan.bBytes, message.b]]) {
      device.queue.writeBuffer(buffer, 0, guard); device.queue.writeBuffer(buffer, bytes + 4, guard); device.queue.writeBuffer(buffer, 4, data);
    }
    const initial = new Float32Array(plan.cElements + 2); initial.fill(NaN); initial[0] = CANARY; initial[initial.length - 1] = CANARY;
    device.queue.writeBuffer(c, 0, initial);
    const words = new Uint32Array(24);
    // m,n,k,inner; A off/row/k/batch; B off/k/column/batch;
    // C off/row/column/batch; bias/flags/alpha. All other words remain zero.
    words.set([plan.m, plan.n, plan.k, 1, 1, plan.k, 1, 0, 0, 1, 1, plan.k, 0, 0, 1, plan.n, 1, 0, 0, 0, 0, 0]);
    new DataView(words.buffer).setFloat32(88, 1, true);
    device.queue.writeBuffer(uniform, 0, words);
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [a, b, c, bias, uniform].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0, bind);pass.dispatchWorkgroups(plan.x, plan.y, 1);pass.end();
    encoder.copyBufferToBuffer(c, 0, readback, 0, plan.cBytes + 8);
    const start = performance.now();
    device.queue.submit([encoder.finish()]);
    await guarded(readback.mapAsync(GPUMapMode.READ)); mapped = true;
    const values = new Float32Array(readback.getMappedRange());
    if (values[0] !== CANARY || values[values.length - 1] !== CANARY) throw new Error("GEMM output canary changed");
    const result = values.slice(1, -1);
    for (const value of result) if (!Number.isFinite(value)) throw new Error("GEMM produced a nonfinite/unwritten result");
    readback.unmap(); mapped = false;
    while (scopeCount > 0) { scopeCount--; const error = await guarded(device.popErrorScope()); if (error) throw new Error(`GPU scoped error: ${String(error.message).slice(0, 512)}`); }
    return { capability, shaderSHA256: sourceHash, dispatched: true, result: result.buffer, canariesIntact: true, chargedApplicationBufferBytes: plan.chargedBytes,
      createdGPUBufferBytes: buffers.reduce((sum, buffer) => sum + buffer.size, 0), paddedMultiplyAdds: plan.paddedWork, actualMultiplyAdds: plan.referenceWork,
      submitToReadbackMilliseconds: performance.now() - start, timingScope: "one cold fixture; includes queue/readback, not an inference benchmark or GPU deadline guarantee" };
  } finally {
    disposed = true;
    cancelGPU = () => {};
    if (mapped) buffers.at(-1)?.unmap();
    for (const buffer of buffers) buffer.destroy();
    for (; scopeCount > 0; scopeCount--) { try { await device.popErrorScope(); } catch {} }
    device.removeEventListener("uncapturederror", uncaptured);
    device.destroy();
  }
}
self.onmessage = (event) => {
  const message = event.data;
  if (accepted) {
    if (message?.abi === ABI && message.id === requestID && message.kind === "cancel" && Object.keys(message).sort().join("|") === "abi|id|kind") { canceled = true; cancelGPU(); }
    return;
  }
  accepted = true;
  requestID = typeof message?.id === "string" ? message.id : "";
  void (async () => {
    validateIdentity(message);
    const plan = validateRequest(message);
    const report = await run(message, plan);
    self.postMessage({ abi: ABI, id: message.id, kind: "result", report }, report.result ? [report.result] : []);
  })().catch((error) => {
    self.postMessage({ abi: ABI, id: typeof message?.id === "string" ? message.id.slice(0, 64) : "invalid", kind: "error", error: String(error.message ?? error).slice(0, 1024) });
  }).finally(() => { self.close(); });
};
