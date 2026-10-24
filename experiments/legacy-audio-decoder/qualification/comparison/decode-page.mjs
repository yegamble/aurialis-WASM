/* Private generated-file PCM collector. Actual fixed-asset production Worker,
 * no mock core, CDR, Blob, persistence, publication, raw download or HTTP audio. */
const MAX_FRAMES = 384001, MAX_BYTES = MAX_FRAMES * 8;
let active = false, currentCancel = null, generation = 0;
const integer = (n, low, high) => Number.isSafeInteger(n) && n >= low && n <= high;
globalThis.result = { status: "idle" };
globalThis.decodeSelected = (workerPath, id) => {
  if (active || !/^[a-z0-9-]{1,64}$/.test(id) || !/^\/decoder\.worker\.[a-f0-9]{64}\.mjs$/.test(workerPath)) throw new Error("Invalid single owned private operation.");
  const file = document.getElementById("fixture").files[0];
  if (!(file instanceof File) || !integer(file.size, 12, 2 * 1024 * 1024)) throw new Error("Selected fixture size invalid.");
  active = true;
  const operation = ++generation;
  let worker = null, timer = null, output = new Uint8Array(MAX_BYTES), total = 0, sequence = 0, geometry = null, terminal = false;
  globalThis.result = { status: "pending", id };
  const stop = () => {
    clearTimeout(timer); worker?.terminate(); worker = null;
    if (generation === operation) { active = false; currentCancel = null; }
  };
  const fail = (message) => {
    if (terminal || generation !== operation) return;
    terminal = true; stop(); output = null;
    globalThis.result = { status: "red", id, error: String(message).slice(0, 1000), framesBeforeFailure: total, published: false, cdrCalled: false };
  };
  currentCancel = () => fail("Driver cancellation.");
  timer = setTimeout(() => fail("Actual Worker130s hard deadline."), 130000);
  try {
    worker = new Worker(workerPath, { type: "module" });
    worker.onerror = (event) => fail(event.message);
    worker.onmessageerror = () => fail("Actual Worker message failed.");
    worker.onmessage = (event) => {
      if (terminal || generation !== operation) return;
      try {
        const data = event.data;
        if (!data || typeof data !== "object" || data.abi !== 1 || data.id !== id) throw new Error("Worker identity/ABI mismatch.");
        if (data.kind === "error") throw new Error(data.error);
        if (data.kind === "end") {
          if (!total || !geometry || data.frames !== total || data.sequence !== sequence || data.rate !== geometry.rate || data.channels !== geometry.channels) throw new Error("Actual Worker incomplete end.");
          stop();
          const bytes = output.subarray(0, total * 8);
          if (typeof bytes.toBase64 !== "function") throw new Error("Browser lacks bounded Uint8Array base64 transport.");
          const audioBase64 = bytes.toBase64(); output = null; terminal = true;
          globalThis.result = { status: "decoded-unqualified", id, frames: total, sequence, rate: geometry.rate, channels: geometry.channels, audioBase64, crossOriginIsolated, published: false, cdrCalled: false };
          return;
        }
        if (data.kind !== "chunk" || data.sequence !== sequence + 1 || !integer(data.frames, 1, 4096) || !integer(data.rate, 8000, 192000) || ![1, 2].includes(data.channels) || !(data.audio instanceof ArrayBuffer) || data.audio.byteLength !== data.frames * 8 || data.frames > MAX_FRAMES - total || (geometry && (data.rate !== geometry.rate || data.channels !== geometry.channels))) throw new Error("Actual Worker malformed chunk.");
        const view = new DataView(data.audio);
        for (let offset = 0; offset < view.byteLength; offset += 4) if (!Number.isFinite(view.getFloat32(offset, true))) throw new Error("Actual Worker nonfinite PCM.");
        output.set(new Uint8Array(data.audio), total * 8);
        geometry ??= { rate: data.rate, channels: data.channels };
        total += data.frames; sequence++;
        worker.postMessage({ kind: "ack", abi: 1, id, sequence });
      } catch (error) {
        fail(error?.message || error);
      }
    };
    worker.postMessage({ kind: "start", abi: 1, id, file, maxFrames: MAX_FRAMES });
  } catch (error) { fail(error?.message || error); }
};
globalThis.cancelOwnedDecode = () => {
  currentCancel?.();
};
