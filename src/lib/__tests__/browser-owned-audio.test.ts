import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

type Layout = { sampleRate: number; frames: number; bitDepth: 16 | 24 | 32 };
class OwnedWorker {
  static all: OwnedWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  message: { id: string } | undefined;
  terminated = false;
  constructor() { OwnedWorker.all.push(this); }
  postMessage(message: { id: string }) { this.message = message; }
  terminate() { this.terminated = true; }
  reply(json = "{}") { const data = { id: this.message?.id, abi: "1.0", kind: "result", json, audio: wav() }; this.onmessage?.({ data } as MessageEvent<unknown>); return data; }
}
const mib = 1024 * 1024, layout: Layout = { sampleRate: 8000, frames: 1, bitDepth: 32 };
function wav() {
  const bytes = new ArrayBuffer(52), view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, 44, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true); view.setUint32(24, 8000, true); view.setUint32(28, 64000, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true); text(36, "data"); view.setUint32(40, 8, true); return bytes;
}
function body(file = new Blob([wav()])) { const form = new FormData(); form.append("file", file, "source.wav"); form.append("bitDepth", "32"); return form; }
async function transport() { return await import("../browser-jobs"); }
const originalRead = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");
beforeEach(() => {
  vi.resetModules(); vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser"); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", "");
  vi.stubGlobal("Worker", OwnedWorker); vi.stubGlobal("fetch", vi.fn()); OwnedWorker.all = [];
  Object.defineProperty(Blob.prototype, "arrayBuffer", { configurable: true, value: function (this: Blob) { return new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(new Error("Invalid fixture read")); }; reader.onerror = () => { reject(new Error("Fixture read failed")); }; reader.readAsArrayBuffer(this); }); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (originalRead) Object.defineProperty(Blob.prototype, "arrayBuffer", originalRead); else Reflect.deleteProperty(Blob.prototype, "arrayBuffer"); });
const active = async (index = 0) => { await waitFor(() => { expect(OwnedWorker.all.at(index)?.message).toBeDefined(); }); const worker = OwnedWorker.all.at(index); if (!worker) throw new Error("Missing worker"); return worker; };

describe("explicit owned binary result handoff", () => {
  it("clears event audio and keeps the exact returned Blob charged until its adopted owner is disposed", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout), worker = await active();
    const payload = worker.reply(), result = await pending;
    expect(payload.audio.byteLength).toBe(0); expect(await result.blob.arrayBuffer()).toEqual(wav()); expect(worker.terminated).toBe(true); expect(fetch).not.toHaveBeenCalled();
    const other = reserveBrowserAudioMemory(448 * mib - 52);
    expect(() => { other.update(448 * mib - 51); }).toThrow(/memory budget/u);
    other.update(448 * mib - 156); result.owner.update(156); expect(() => { other.update(448 * mib - 155); }).toThrow(/memory budget/u);
    other.dispose(); result.dispose(); result.dispose(); expect(() => { result.owner.update(0); }).toThrow(/released/u);
    reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("keeps the old job estimate live during reentrant Blob construction", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout); await active();
    const NativeBlob = Blob; let checked = false;
    vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { expect(() => reserveBrowserAudioMemory(448 * mib - 52)).toThrow(/memory budget/u); checked = true; super(parts, options); } });
    OwnedWorker.all[0]?.reply(); const result = await pending; expect(checked).toBe(true); result.dispose();
  });
  it("does not let a stale or repeated result handler clear a later job owner", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    const first = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout), worker = await active(), stale = worker.onmessage;
    const staleId = worker.message?.id; worker.reply(); const owned = await first;
    const second = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout), next = await active(1);
    for (let index = 0; index < 2; index++) stale?.({ data: { abi: "1.0", kind: "result", id: staleId, json: "{}", audio: wav() } } as MessageEvent<unknown>);
    expect(() => reserveBrowserAudioMemory(448 * mib - 104)).toThrow(/memory budget/u);
    next.reply(); const other = await second; owned.dispose(); other.dispose(); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("counts the handed-off output before admitting an already queued worker", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    const bigSize = 16 * mib, prefix = reserveBrowserAudioMemory(448 * mib - 5 * bigSize - 56);
    const first = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout); await active();
    const large = new File([wav()], "source.wav"); Object.defineProperty(large, "size", { value: bigSize }); const read = vi.spyOn(large, "arrayBuffer");
    const largeForm = new FormData(); largeForm.append("file", large); largeForm.append("bitDepth", "32");
    const second = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: largeForm }, layout), rejected = second.catch((cause: unknown) => cause);
    OwnedWorker.all[0]?.reply(); const owned = await first;
    expect(await rejected).toBeInstanceOf(Error); expect(read).not.toHaveBeenCalled(); expect(OwnedWorker.all).toHaveLength(1);
    prefix.dispose(); owned.dispose(); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("checks a reentrant resident increase at the exact one-byte-short replacement boundary", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    let memory = 8, changeAtRead = false, late: ReturnType<typeof reserveBrowserAudioMemory> | undefined;
    vi.stubGlobal("navigator", { get deviceMemory() { if (changeAtRead) { changeAtRead = false; late = reserveBrowserAudioMemory(16); memory = 2; } return memory; } });
    const prefix = reserveBrowserAudioMemory(192 * mib - 119);
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout), rejected = pending.catch((cause: unknown) => cause); await active();
    const NativeBlob = Blob; vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { super(parts, options); changeAtRead = true; } });
    OwnedWorker.all[0]?.reply(); expect(await rejected).toBeInstanceOf(Error); expect(OwnedWorker.all[0]?.terminated).toBe(true);
    const exact = reserveBrowserAudioMemory(103); expect(() => { exact.update(104); }).toThrow(/memory budget/u); exact.dispose(); late?.dispose(); prefix.dispose(); reserveBrowserAudioMemory(192 * mib).dispose();
  });
  it("disposes an already-published landing owner when cancellation arrives during its atomic handoff", async () => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport(), controller = new AbortController();
    let cancelOnBudgetRead = false;
    vi.stubGlobal("navigator", { get deviceMemory() { if (cancelOnBudgetRead) { cancelOnBudgetRead = false; controller.abort(); } return 8; } });
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body(), signal: controller.signal }, layout), rejected = pending.catch((cause: unknown) => cause); await active();
    const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { super(parts, options); cancelOnBudgetRead = true; } });
    OwnedWorker.all[0]?.reply(); expect(await rejected).toMatchObject({ name: "AbortError" });
    reserveBrowserAudioMemory(960 * mib).dispose();
  });
  it.each(["blob", "metadata", "cancel"] as const)("discards late %s failures while releasing every handoff reservation", async (failure) => {
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport(), controller = new AbortController();
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body(), signal: controller.signal }, layout), rejected = pending.catch((cause: unknown) => cause); await active();
    let constructions = 0; const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { constructions++; if (failure === "blob") throw new Error("Blob unavailable"); super(parts, options); if (failure === "cancel") controller.abort(); } });
    const payload = OwnedWorker.all[0]?.reply(failure === "metadata" ? "broken-json" : "{}"); const cause = await rejected;
    expect(payload?.audio.byteLength).toBe(0); expect(payload?.json).toBe("");
    if (failure === "cancel") expect(cause).toMatchObject({ name: "AbortError" }); else expect(cause).toBeInstanceOf(Error);
    await waitFor(() => { expect(OwnedWorker.all[0]?.terminated).toBe(true); });
    expect(constructions).toBe(failure === "metadata" ? 0 : 1); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("claims native landing bytes before fetch and rejects mismatched Content-Length before reading", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native");
    const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    const cancel = vi.fn(), response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Length": "53", "Content-Type": "audio/wav" } }), reader = vi.spyOn(response.body as ReadableStream<Uint8Array>, "getReader");
    vi.mocked(fetch).mockImplementation(() => { expect(() => reserveBrowserAudioMemory(448 * mib - 155)).toThrow(/memory budget/u); return Promise.resolve(response); });
    await expect(deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout)).rejects.toThrow(/length/u);
    expect(reader).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("holds native read and cancellation ownership until actual cancel settlement", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    let finishCancel = () => { /* Assigned before cancellation. */ }; const held = new Promise<void>((resolve) => { finishCancel = resolve; }), canceled = vi.fn(() => held);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(wav(), 0, 20)); }, cancel: canceled });
    vi.mocked(fetch).mockResolvedValue(new Response(stream, { headers: { "Content-Type": "audio/wav" } }));
    const controller = new AbortController(); let settled = false;
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body(), signal: controller.signal }, layout).then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => { expect(fetch).toHaveBeenCalledOnce(); }); controller.abort(); await waitFor(() => { expect(canceled).toHaveBeenCalledOnce(); });
    expect(settled).toBe(false); expect(() => reserveBrowserAudioMemory(448 * mib - 155)).toThrow(/memory budget/u);
    finishCancel(); await pending; expect(settled).toBe(true); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("keeps native allocation failure owned until its locked reader cancellation actually settles", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    let finishCancel = () => { /* Assigned before the attempted allocation. */ }; const held = new Promise<void>((resolve) => { finishCancel = resolve; }), canceled = vi.fn(() => held);
    const stream = new ReadableStream<Uint8Array>({ cancel: canceled }), response = new Response(stream, { headers: { "Content-Type": "audio/wav" } });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => { reader = getReader(); return reader; });
    const form = body();
    const NativeBytes = Uint8Array, NativeBlob = Blob; let outputBlobs = 0;
    vi.mocked(fetch).mockImplementationOnce(() => {
      vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { if (parts?.length) outputBlobs++; super(parts, options); } });
      return Promise.resolve(response);
    });
    vi.stubGlobal("Uint8Array", class extends NativeBytes { constructor(length: number) { if (length === 52) throw new Error("allocation denied"); super(length); } });
    let settled = false;
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: form }, layout).then(() => { settled = true; return null; }, (cause: unknown) => { settled = true; return cause; });
    try {
      await waitFor(() => { expect(reader).toBeDefined(); });
      expect(settled).toBe(false); expect(stream.locked).toBe(true); expect(outputBlobs).toBe(0);
      await waitFor(() => { expect(canceled).toHaveBeenCalledOnce(); });
      const other = reserveBrowserAudioMemory(448 * mib - 156);
      vi.stubGlobal("Blob", NativeBlob);
      vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
      try { await expect(deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: form }, layout)).rejects.toThrow(/memory budget/u); expect(OwnedWorker.all).toHaveLength(0); }
      finally { other.dispose(); }
      finishCancel(); expect(await pending).toMatchObject({ message: "allocation denied" });
      expect(stream.locked).toBe(false); reserveBrowserAudioMemory(448 * mib).dispose();
    } finally {
      finishCancel(); if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } await pending;
    }
  });
  it("cancels a native reader aborted during acquisition before allocating or reading its body", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport(), controller = new AbortController();
    const canceled = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel: canceled }), getReader = stream.getReader.bind(stream);
    const read = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    vi.spyOn(stream, "getReader").mockImplementation(() => { const acquired = getReader(); vi.spyOn(acquired, "read").mockImplementation(read); controller.abort(); return acquired; });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "audio/wav" } }));
    await expect(deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body(), signal: controller.signal }, layout)).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled(); expect(canceled).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false); reserveBrowserAudioMemory(448 * mib).dispose();
  });
  it("disposes a native landing owner canceled during its final resident update", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport(), controller = new AbortController();
    let cancelOnBudgetRead = false;
    vi.stubGlobal("navigator", { get deviceMemory() { if (cancelOnBudgetRead) { cancelOnBudgetRead = false; controller.abort(); } return 8; } });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(wav(), { headers: { "Content-Type": "audio/wav" } }));
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body(), signal: controller.signal }, layout), rejected = pending.catch((cause: unknown) => cause);
    const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { super(parts, options); cancelOnBudgetRead = true; } });
    expect(await rejected).toMatchObject({ name: "AbortError" }); reserveBrowserAudioMemory(960 * mib).dispose();
  });
  it("bounds native responses without Content-Length and validates their exact encoded geometry", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); const { deviceOwnedAudioRequest, reserveBrowserAudioMemory } = await transport();
    for (const bytes of [new Uint8Array(53), new Uint8Array(51), new Uint8Array(52)]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "audio/wav" } }));
      await expect(deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout)).rejects.toThrow(/length|layout/u);
      reserveBrowserAudioMemory(448 * mib).dispose();
    }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(wav(), { headers: { "Content-Type": "audio/wav" } }));
    const result = await deviceOwnedAudioRequest("/api/master/render", { method: "POST", body: body() }, layout); expect(await result.blob.arrayBuffer()).toEqual(wav()); result.dispose();
  });
});
