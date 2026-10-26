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
/** A header-only WAV whose `fmt ` follows JUNK and an odd-sized, padded bext chunk. */
function paddedSource(rate: number, frames: number) {
  const bytes = new ArrayBuffer(12 + 8 + 28 + 8 + 9 + 1 + 8 + 16 + 8), view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8 + frames * 8, true); text(8, "WAVE");
  text(12, "JUNK"); view.setUint32(16, 28, true);
  text(48, "bext"); view.setUint32(52, 9, true);
  text(66, "fmt "); view.setUint32(70, 16, true); view.setUint16(74, 3, true); view.setUint16(76, 2, true); view.setUint32(78, rate, true); view.setUint32(82, rate * 8, true); view.setUint16(86, 8, true); view.setUint16(88, 32, true);
  text(90, "data"); view.setUint32(94, frames * 8, true);
  return new Blob([bytes], { type: "audio/wav" });
}
function render(file: Blob, sampleRate?: string) { const form = new FormData(); form.append("file", file, "source.wav"); form.append("bitDepth", "16"); if (sampleRate) form.append("sampleRate", sampleRate); return form; }
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

  it("forwards validated export rate and dither fields to the render worker", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const form = body(); form.append("bitDepth", "16"); form.append("sampleRate", "44100"); form.append("dither", "none");
    const pending = deviceAudioRequest("/api/master/render", { method: "POST", body: form });
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    expect(JSON.parse(TestWorker.all[0]?.message?.metadata ?? "{}")).toEqual({ operation: "render", bitDepth: 16, sampleRate: 44100, dither: "none" });
    TestWorker.all[0]?.reply(); await pending;
    for (const [field, value] of [["sampleRate", "22050"], ["sampleRate", "48k"], ["dither", "shaped"]] as const) {
      const invalid = body(); invalid.append(field, value);
      await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: invalid })).rejects.toThrow(field === "dither" ? "dither" : "export rate");
    }
    expect(TestWorker.all).toHaveLength(1);
  });
  it("reads the fmt rate after JUNK and bext chunks when budgeting a converted export", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    // 4,194,304 frames: 48 → 96 kHz fits the 512 MiB budget; the 8 kHz
    // unreadable-rate assumption would not, so this proves the rate was read.
    const pending = deviceAudioRequest("/api/master/render", { method: "POST", body: render(paddedSource(48000, 4_194_304), "96000") });
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    TestWorker.all[0]?.reply(); await pending;
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(paddedSource(5000, 4_194_304), "96000") })).rejects.toThrow("memory budget");
    expect(TestWorker.all).toHaveLength(1);
  });

  it("extends the worker deadline by the conversion cost only when the rate changes", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const timer = vi.spyOn(globalThis, "setTimeout");
    const deadline = async (sampleRate?: string) => {
      timer.mockClear();
      const pending = deviceAudioRequest("/api/master/render", { method: "POST", body: render(paddedSource(48000, 4_194_304), sampleRate) });
      await waitFor(() => { expect(TestWorker.all.at(-1)?.message).toBeDefined(); });
      const delays = timer.mock.calls.map(([, delay]) => delay ?? 0).filter((delay) => delay >= 100_000);
      TestWorker.all.at(-1)?.reply(); await pending;
      return delays;
    };
    expect(await deadline()).toEqual([130_000]);
    expect(await deadline("48000")).toEqual([130_000]);
    expect(await deadline("44100")).toEqual([325_000]);
    expect(await deadline("96000")).toEqual([520_000]);
    timer.mockRestore();
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
    Object.defineProperty(oversized, "size", { value: 200 * 1024 * 1024 });
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

  it("charges waiting raw input before enqueueing and rejects excess memory without cloning", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const { deviceAudioRequest } = await import("../browser-jobs");
    const activeFile = new File([source()], "active.wav");
    Object.defineProperty(activeFile, "size", { value: 16 * 1024 * 1024 });
    const activeBody = new FormData(); activeBody.append("file", activeFile);
    const first = deviceAudioRequest("/api/master/render", { method: "POST", body: activeBody });
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const waiting = new File([source()], "waiting.wav");
    Object.defineProperty(waiting, "size", { value: 160 * 1024 * 1024 });
    const read = vi.spyOn(waiting, "arrayBuffer");
    const waitingBody = new FormData(); waitingBody.append("file", waiting);
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: waitingBody })).rejects.toThrow("memory budget");
    expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(1);
    TestWorker.all[0]?.reply(); await first;
    const next = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    await waitFor(() => { expect(TestWorker.all[1]?.message).toBeDefined(); });
    TestWorker.all[1]?.reply(); await next;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains canceled waiting input until the underlying queue turn actually settles", async () => {
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const first = deviceAudioRequest("/api/analyze/features", { method: "POST", body: body() });
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const waiting = new File([source()], "waiting.wav");
    Object.defineProperty(waiting, "size", { value: 100 * 1024 * 1024 });
    const read = vi.spyOn(waiting, "arrayBuffer");
    const form = new FormData(); form.append("file", waiting);
    const controller = new AbortController(), owner = reserveBrowserAudioMemory();
    const second = deviceAudioRequest("/api/analyze/features", { method: "POST", body: form, signal: controller.signal });
    const canceled = second.then(() => undefined, (error: unknown) => error);
    try {
      expect(() => { owner.update(350 * 1024 * 1024); }).toThrow("memory budget");
      controller.abort(); expect(await canceled).toMatchObject({ name: "AbortError" });
      expect(() => { owner.update(350 * 1024 * 1024); }).toThrow("memory budget");
      expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(1);
      TestWorker.all[0]?.reply(); await first;
      await waitFor(() => { expect(() => { owner.update(350 * 1024 * 1024); }).not.toThrow(); });
      expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(1);
    } finally { owner.dispose(); controller.abort(); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an 8 GB-class device", { deviceMemory: 8 }, undefined, 2048],
    ["a desktop browser that hides device memory", {}, false, 1536],
    ["a touch device that hides device memory", {}, true, 1024],
    ["a 4 GB device", { deviceMemory: 4 }, undefined, 512],
    ["a 2 GB device", { deviceMemory: 2 }, undefined, 256],
  ])("sizes the local audio memory budget for %s", async (_name, device, coarse, budgetMiB) => {
    vi.stubGlobal("navigator", device);
    if (coarse !== undefined) vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query === "(pointer: coarse)" }));
    const { reserveBrowserAudioMemory } = await import("../browser-jobs");
    const mib = 1024 * 1024;
    // Retained audio plus the 64 MiB job floor must fit the budget.
    const fits = reserveBrowserAudioMemory((budgetMiB - 64) * mib);
    fits.dispose();
    expect(() => reserveBrowserAudioMemory((budgetMiB - 63) * mib)).toThrow("memory budget");
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
