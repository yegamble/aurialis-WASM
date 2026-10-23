/* One disposable job, one private Go heap. No audio is sent over the network. */
const OFFLINE_ABI = "1.0";
let accepted = false;
self.onmessage = (event) => {
  if (accepted) return;
  accepted = true;
  const request = event.data;
  const fail = (error) => {
    const message = error instanceof Error ? error.message : "Local audio processing failed.";
    self.postMessage({ abi: OFFLINE_ABI, kind: "error", id: request?.id, error: message.slice(0, 1024), processingBuild: request?.processing?.fingerprint ?? "" });
    self.close();
  };
  const run = async () => {
    if (!request || request.abi !== OFFLINE_ABI || typeof request.id !== "string" || request.id.length > 80 || typeof request.metadata !== "string" || request.metadata.length > 2_228_224 || !(request.source instanceof ArrayBuffer) || !(request.reference instanceof ArrayBuffer) || request.source.byteLength + request.reference.byteLength > 135_266_304) throw new Error("Invalid local audio request.");
    const processing = request.processing ?? null;
    if (processing !== null && (typeof processing !== "object" || Array.isArray(processing) || Object.keys(processing).length !== 3 || !Number.isSafeInteger(processing.offlineBytes) || processing.offlineBytes < 8 || processing.offlineBytes > 25 * 1024 * 1024 || ![processing.fingerprint, processing.offlineSha256].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))) throw new Error("Invalid local processing identity.");
    const suffix = processing ? `?processing=${processing.fingerprint}` : "";
    importScripts("/wasm/wasm_exec.js" + suffix);
    if (typeof self.Go !== "function") throw new Error("The local Go audio runtime is unavailable.");
    const go = new self.Go();
    const response = await fetch("/wasm/aurialis-dsp.wasm" + suffix, { cache: "no-store" });
    if (!response.ok) throw new Error("The local audio engine could not load. Reload to retry.");
    let moduleBytes;
    if (processing) {
      if (!response.body) throw new Error("The processing module response is unreadable.");
      const reader = response.body.getReader(), bytes = new Uint8Array(processing.offlineBytes);
      let received = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength === 0 || received + chunk.value.byteLength > bytes.length) throw new Error("The processing module has an unexpected length.");
          bytes.set(chunk.value, received); received += chunk.value.byteLength;
        }
        if (received !== bytes.length) throw new Error("The processing module has an unexpected length.");
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      moduleBytes = bytes.buffer;
    } else moduleBytes = await response.arrayBuffer();
    if (processing) {
      const digest = await crypto.subtle.digest("SHA-256", moduleBytes);
      const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== processing.offlineSha256) throw new Error("The fetched processing module does not match this build. Reload the app.");
    }
    const wasm = await WebAssembly.instantiate(moduleBytes, go.importObject);
    void go.run(wasm.instance).catch(fail);
    if (self.aurialisOfflineAbi !== OFFLINE_ABI || typeof self.aurialisOfflineJob !== "function") throw new Error("The local audio engine version is incompatible. Reload to retry.");
    const result = self.aurialisOfflineJob(request.metadata, new Uint8Array(request.source), new Uint8Array(request.reference), (progress, stage) => {
      self.postMessage({ abi: OFFLINE_ABI, kind: "progress", id: request.id, progress, stage, processingBuild: processing?.fingerprint ?? "" });
    });
    if (!result || result.ok !== true || typeof result.json !== "string" || !(result.audio instanceof Uint8Array)) throw new Error(typeof result?.error === "string" ? result.error : "Local audio processing returned an invalid result.");
    self.postMessage({ abi: OFFLINE_ABI, kind: "result", id: request.id, json: result.json, audio: result.audio.buffer, processingBuild: processing?.fingerprint ?? "" }, [result.audio.buffer]);
    self.close();
  };
  void run().catch(fail);
};
