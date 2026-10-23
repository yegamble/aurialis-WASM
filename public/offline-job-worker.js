/* One disposable job, one private Go heap. No audio is sent over the network. */
const OFFLINE_ABI = "1.0";
let accepted = false;
self.onmessage = (event) => {
  if (accepted) return;
  accepted = true;
  const request = event.data;
  const fail = (error) => {
    const message = error instanceof Error ? error.message : "Local audio processing failed.";
    self.postMessage({ abi: OFFLINE_ABI, kind: "error", id: request?.id, error: message.slice(0, 1024) });
    self.close();
  };
  const run = async () => {
    if (!request || request.abi !== OFFLINE_ABI || typeof request.id !== "string" || request.id.length > 80 || typeof request.metadata !== "string" || request.metadata.length > 2_228_224 || !(request.source instanceof ArrayBuffer) || !(request.reference instanceof ArrayBuffer) || request.source.byteLength + request.reference.byteLength > 135_266_304) throw new Error("Invalid local audio request.");
    importScripts("/wasm/wasm_exec.js");
    if (typeof self.Go !== "function") throw new Error("The local Go audio runtime is unavailable.");
    const go = new self.Go();
    const response = await fetch("/wasm/aurialis-dsp.wasm", { cache: "no-cache" });
    if (!response.ok) throw new Error("The local audio engine could not load. Reload to retry.");
    const wasm = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    void go.run(wasm.instance).catch(fail);
    if (self.aurialisOfflineAbi !== OFFLINE_ABI || typeof self.aurialisOfflineJob !== "function") throw new Error("The local audio engine version is incompatible. Reload to retry.");
    const result = self.aurialisOfflineJob(request.metadata, new Uint8Array(request.source), new Uint8Array(request.reference), (progress, stage) => {
      self.postMessage({ abi: OFFLINE_ABI, kind: "progress", id: request.id, progress, stage });
    });
    if (!result || result.ok !== true || typeof result.json !== "string" || !(result.audio instanceof Uint8Array)) throw new Error(typeof result?.error === "string" ? result.error : "Local audio processing returned an invalid result.");
    self.postMessage({ abi: OFFLINE_ABI, kind: "result", id: request.id, json: result.json, audio: result.audio.buffer }, [result.audio.buffer]);
    self.close();
  };
  void run().catch(fail);
};
