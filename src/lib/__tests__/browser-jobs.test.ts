import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

class TestWorker {
  static all: TestWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  message: { id: string; metadata: string; source: ArrayBuffer; reference: ArrayBuffer } | undefined;
  transfer: Transferable[] = [];
  constructor(readonly url: string) { TestWorker.all.push(this); }
  postMessage(message: { id: string; metadata: string; source: ArrayBuffer; reference: ArrayBuffer }, transfer: Transferable[]) { this.message = message; this.transfer = transfer; }
  terminate() { this.terminated = true; }
  reply(json = "{}", id = this.message?.id) { this.onmessage?.({ data: { abi: "1.0", kind: "result", id, json, audio: new ArrayBuffer(0) } } as MessageEvent<unknown>); }
}

function source() {
  const bytes = new ArrayBuffer(52), view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, 44, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true); view.setUint32(24, 8000, true); view.setUint32(28, 64000, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true); text(36, "data"); view.setUint32(40, 8, true);
  return new Blob([bytes], { type: "audio/wav" });
}
function body() { const form = new FormData(); form.append("file", source(), "source.wav"); return form; }

const originalArrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");
beforeEach(() => {
  Object.defineProperty(Blob.prototype, "arrayBuffer", { configurable: true, writable: true, value: function (this: Blob) { return new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(new Error("Invalid fixture Blob read")); }; reader.onerror = () => { reject(new Error("Fixture Blob read failed")); }; reader.readAsArrayBuffer(this); }); } });
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
  TestWorker.all = [];
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (originalArrayBuffer) Object.defineProperty(Blob.prototype, "arrayBuffer", originalArrayBuffer); else Reflect.deleteProperty(Blob.prototype, "arrayBuffer"); });

describe("device-local browser audio transport", () => {
  it("transfers raw buffers once, keeps metadata separate, and terminates after completion without fetch", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const pending = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    await waitFor(() => { expect(TestWorker.all).toHaveLength(1); expect(TestWorker.all[0]?.message).toBeDefined(); });
    const worker = TestWorker.all[0];
    if (!worker) throw new Error("Missing fixture worker");
    expect(worker.url).toBe("/offline-job-worker.js");
    expect(worker.message?.metadata).toBe('{"operation":"features"}');
    expect(worker.transfer).toEqual([worker.message?.source, worker.message?.reference]);
    expect(worker.message?.source.byteLength).toBe(52);
    worker.reply('{"kind":"analyze_features","status":"done"}');
    expect(await (await pending).json()).toEqual({ kind: "analyze_features", status: "done" });
    expect(worker.terminated).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("terminates an active canceled worker before the queued job creates another", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const controller = new AbortController();
    const first = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body(), signal: controller.signal });
    const canceled = first.then(() => undefined, (error: unknown) => error);
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const second = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    await expect(deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() })).rejects.toThrow("busy");
    expect(TestWorker.all).toHaveLength(1);
    controller.abort();
    expect(await canceled).toMatchObject({ name: "AbortError" });
    await waitFor(() => { expect(TestWorker.all[1]?.message).toBeDefined(); });
    expect(TestWorker.all[0]?.terminated).toBe(true);
    TestWorker.all[1]?.reply();
    await second;
    expect(TestWorker.all.every((worker) => worker.terminated)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe browser memory before creating a worker or reading the full file", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const oversized = new File([source()], "source.wav");
    Object.defineProperty(oversized, "size", { value: 128 * 1024 * 1024 });
    const read = vi.spyOn(oversized, "arrayBuffer");
    const form = new FormData(); form.append("file", oversized);
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form })).rejects.toThrow("memory budget");
    expect(read).not.toHaveBeenCalled();
    expect(TestWorker.all).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sums owned retained audio before cloning and releases only the updated or disposed owner", async () => {
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const mib = 1024 * 1024;
    const first = reserveBrowserAudioMemory(200 * mib), second = reserveBrowserAudioMemory(200 * mib);
    const file = new File([source()], "source.wav");
    Object.defineProperty(file, "size", { value: 16 * mib });
    const read = vi.spyOn(file, "arrayBuffer");
    const form = new FormData(); form.append("file", file);
    try {
      await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form })).rejects.toThrow("memory budget");
      expect(read).not.toHaveBeenCalled();
      expect(TestWorker.all).toHaveLength(0);
      second.update(0);
      const accepted = deviceAudioRequest("/api/master/render", { method: "POST", body: form });
      await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
      expect(() => { second.update(200 * mib); }).toThrow("memory budget");
      TestWorker.all[0]?.reply(); await accepted;
      expect(() => { second.update(200 * mib); }).not.toThrow();
      first.dispose(); first.dispose();
      expect(() => { first.update(1); }).toThrow("released");
      expect(TestWorker.all[0]?.terminated).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { first.dispose(); second.dispose(); }
  });

  it("rejects a cache increase between preflight and clone and releases the failed job charge", async () => {
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const owner = reserveBrowserAudioMemory();
    const file = new File([source()], "source.wav");
    Object.defineProperty(file, "size", { value: 16 * 1024 * 1024 });
    const read = vi.spyOn(file, "arrayBuffer");
    const form = new FormData(); form.append("file", file);
    try {
      await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form }, () => { owner.update(400 * 1024 * 1024); })).rejects.toThrow("memory budget");
      expect(read).not.toHaveBeenCalled();
      expect(TestWorker.all).toHaveLength(0);
      expect(() => { owner.update(400 * 1024 * 1024); }).not.toThrow();
    } finally { owner.dispose(); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed or unsafe retained-byte counts without changing existing reservations", async () => {
    const { reserveBrowserAudioMemory } = await import("../browser-jobs");
    const held = reserveBrowserAudioMemory(1024);
    try {
      for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => { held.update(bytes); }).toThrow("safe byte counts");
        expect(() => reserveBrowserAudioMemory(bytes)).toThrow("safe byte counts");
      }
      expect(() => { held.update(Number.MAX_SAFE_INTEGER); }).toThrow("memory budget");
      expect(() => { held.update(0); }).not.toThrow();
      expect(Object.isFrozen(held)).toBe(true);
    } finally { held.dispose(); }
    expect(TestWorker.all).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("always selects browser execution for public origins and refuses remote audio URLs", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native");
    vi.stubGlobal("location", { hostname: "aurialis.yosefgamble.com", origin: "https://aurialis.yosefgamble.com" });
    const { usesBrowserAudio, deviceAudioRequest } = await import("../browser-jobs");
    expect(usesBrowserAudio()).toBe(true);
    await expect(deviceAudioRequest("https://evil.example/api/master/render", { method: "POST", body: body() })).rejects.toThrow("stay on this device");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the native HTTP transport solely on exact device-loopback origins", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native");
    vi.stubGlobal("location", { hostname: "localhost", origin: "http://localhost:8080" });
    vi.mocked(fetch).mockResolvedValue(new Response("{}"));
    const { usesBrowserAudio, deviceAudioRequest } = await import("../browser-jobs");
    expect(usesBrowserAudio()).toBe(false);
    await deviceAudioRequest("/api/master/render", { method: "POST", body: body() });
    expect(fetch).toHaveBeenCalledOnce();
    expect(TestWorker.all).toHaveLength(0);
  });

  it("rejects stale worker identities and still releases the private heap", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const pending = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    const rejected = pending.then(() => undefined, (error: unknown) => error);
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    TestWorker.all[0]?.reply("{}", "foreign-job");
    expect(await rejected).toMatchObject({ message: "Invalid local audio worker identity." });
    expect(TestWorker.all[0]?.terminated).toBe(true);
  });
  it("rejects an incompatible worker ABI and creates a fresh worker on explicit retry", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const first = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    const failure = first.then(() => undefined, (error: unknown) => error);
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const stale = TestWorker.all[0];
    stale?.onmessage?.({ data: { abi: "0.0", kind: "result", id: stale.message?.id, json: "{}", audio: new ArrayBuffer(0) } } as MessageEvent<unknown>);
    expect(await failure).toMatchObject({ message: "The local audio engine version is incompatible. Reload Aurialis to retry." });
    expect(stale?.terminated).toBe(true);
    const retry = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    await waitFor(() => { expect(TestWorker.all[1]?.message).toBeDefined(); });
    TestWorker.all[1]?.reply();
    await retry;
    expect(TestWorker.all[1]?.terminated).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

});
