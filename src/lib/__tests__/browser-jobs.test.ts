import { readFileSync } from "node:fs";
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

function compressedFile() {
  return new File([new Uint8Array(readFileSync("src/lib/__tests__/silence-8m.flac"))], "silence-8m.flac");
}
function mp3Frames() {
  // This fixture's leading ID3v2 tag is 45 bytes; its remaining 12 actual frames
  // include the Info frame, so counting every frame is conservative for Go.
  return new Uint8Array(readFileSync("internal/audio/testdata/tone-44k-cbr.mp3")).slice(45);
}
/** Let an incorrectly admitted job settle, so a rejected-admission assertion fails promptly. */
function replyToAdmittedJobs() {
  vi.spyOn(TestWorker.prototype, "postMessage").mockImplementation(function (this: TestWorker, message, transfer) {
    this.message = message; this.transfer = transfer;
    queueMicrotask(() => { this.reply(); });
  });
}

const originalArrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");
beforeEach(() => {
  Object.defineProperty(Blob.prototype, "arrayBuffer", { configurable: true, writable: true, value: function (this: Blob) { return new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(new Error("Invalid fixture Blob read")); }; reader.onerror = () => { reject(new Error("Fixture Blob read failed")); }; reader.readAsArrayBuffer(this); }); } });
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
  TestWorker.all = [];
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (originalArrayBuffer) Object.defineProperty(Blob.prototype, "arrayBuffer", originalArrayBuffer); else Reflect.deleteProperty(Blob.prototype, "arrayBuffer"); });

describe("compressed admission header capacity", () => {
  it.each([
    { name: "CBR MPEG-1", data: new Uint8Array(readFileSync("internal/audio/testdata/tone-44k-cbr.mp3")), rate: 44100, frames: 13824 },
    { name: "VBR MPEG-1 with ID3v1 trailer", data: new Uint8Array(readFileSync("internal/audio/testdata/tone-44k-vbr.mp3")), rate: 44100, frames: 13824 },
    { name: "mono MPEG-2 with padding", data: new Uint8Array(readFileSync("internal/audio/testdata/tone-22k-mono.mp3")), rate: 22050, frames: 6336 },
  ])("bounds real $name output including info frames and gapless padding", async ({ data, rate, frames }) => {
    const { audioInputShape } = await import("../audio-input-shape");
    expect(await audioInputShape(new Blob([data]), new AbortController().signal)).toEqual({ bytes: frames * 8, rate });
  });

  it("reads MP3 headers across 64 KiB chunks and skips repeated ID3 tags and footers", async () => {
    const { audioInputShape } = await import("../audio-input-shape");
    const id3 = new Uint8Array(65_525); id3.set([73, 68, 51, 4, 0, 16]);
    // Body + optional 10-byte footer puts the first MPEG header at offset 65,535.
    const size = id3.length - 20;
    for (let i = 0; i < 4; i++) id3[9 - i] = (size >>> (7 * i)) & 127;
    const emptyTag = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
    expect(await audioInputShape(new Blob([emptyTag, id3, mp3Frames()]), new AbortController().signal)).toEqual({ bytes: 13824 * 8, rate: 44100 });
  });

  it("ignores fake Xing frame counts and falls back for truncated or mixed-version/rate chains", async () => {
    const { audioInputShape } = await import("../audio-input-shape");
    const original = mp3Frames(), fake = original.slice();
    // The first stereo MPEG-1 frame carries an Info header after its side info.
    expect(String.fromCharCode(...fake.slice(36, 40))).toBe("Info");
    fake.fill(0, 44, 48);
    expect(await audioInputShape(new Blob([fake]), new AbortController().signal)).toEqual({ bytes: 13824 * 8, rate: 44100 });
    const mixedVersion = original.slice(), mixedRate = original.slice();
    // First frame: floor(144 * 192000 / 44100) = 626 bytes.
    mixedVersion[627] = (mixedVersion[627] ?? 0) & 0xf7;
    mixedRate[628] = (mixedRate[628] ?? 0) | 4;
    for (const data of [original.slice(0, -1), mixedVersion, mixedRate, new Uint8Array([73, 68, 51, 4, 0, 0, 128, 0, 0, 0])]) {
      expect(await audioInputShape(new Blob([data]), new AbortController().signal)).toEqual({ bytes: 33_554_432 * 8, rate: undefined });
    }
  });

  it("uses the conservative bound when a WAV fmt chunk lies beyond the header window", async () => {
    const { audioInputShape } = await import("../audio-input-shape");
    const prefix = new Uint8Array(20 + 65_536), view = new DataView(prefix.buffer);
    prefix.set([82, 73, 70, 70], 0); prefix.set([87, 65, 86, 69, 74, 85, 78, 75], 8);
    view.setUint32(16, 65_536, true);
    expect(await audioInputShape(new Blob([prefix, source().slice(12)]), new AbortController().signal)).toEqual({ bytes: 33_554_432 * 8, rate: undefined });
  });

  it("preserves the format-proven byte expansion bound for uncompressed AIFF", async () => {
    const { audioInputShape } = await import("../audio-input-shape");
    const header = new Uint8Array(54); header.set([70, 79, 82, 77]); header.set([65, 73, 70, 70], 8);
    expect(await audioInputShape(new Blob([header]), new AbortController().signal)).toEqual({ bytes: 54 * 8, rate: undefined });
  });
});

describe("device-local browser audio transport", () => {
  it("rejects a real tiny FLAC expanding beyond the low-device budget before cloning or worker creation", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const file = compressedFile(), read = vi.spyOn(file, "arrayBuffer");
    const form = new FormData(); form.append("file", file);
    // Verified FLAC silence: 8,388,480 stereo frames in 2,090 bytes, over 32,000x expansion.
    expect(file.size).toBe(2090);
    replyToAdmittedJobs();
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form })).rejects.toThrow("memory budget");
    expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(0);
    const owner = reserveBrowserAudioMemory(192 * 1024 * 1024); owner.dispose();
  });

  it("uses the full decoded bound for unknown FLAC duration and ambiguous non-WAV input", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const { deviceAudioRequest } = await import("../browser-jobs");
    const unknown = new Uint8Array(readFileSync("src/lib/__tests__/silence-8m.flac"));
    unknown[21] = (unknown[21] ?? 0) & 0xf0; unknown.fill(0, 22, 26);
    replyToAdmittedJobs();
    for (const file of [new Blob([unknown]), new Blob(["unrecognized audio"])]) {
      await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(file) })).rejects.toThrow("memory budget");
    }
    expect(TestWorker.all).toHaveLength(0);
  });

  it("charges source and reference FLAC capacity independently and releases rejected reservations", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const owner = reserveBrowserAudioMemory(128 * 1024 * 1024);
    replyToAdmittedJobs();
    try {
      // Either source alone fits; their combined decoded working set does not.
      const single = new FormData(); single.append("file", compressedFile());
      await expect(deviceAudioRequest("/api/analyze/features", { method: "POST", body: single })).resolves.toHaveProperty("status", 200);
      const form = new FormData(); form.append("source", compressedFile()); form.append("reference", compressedFile());
      await expect(deviceAudioRequest("/api/analyze/reference", { method: "POST", body: form })).rejects.toThrow("memory budget");
      expect(TestWorker.all).toHaveLength(1);
      expect(() => { owner.update(448 * 1024 * 1024); }).not.toThrow();
    } finally { owner.dispose(); }
  });

  it("keeps an ordinary three-minute MP3 within a 512 MiB device budget", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    const { deviceAudioRequest } = await import("../browser-jobs");
    const frames = mp3Frames(), file = new File(Array.from({ length: 600 }, () => frames), "three-minutes.mp3");
    replyToAdmittedJobs();
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(file) })).resolves.toHaveProperty("status", 200);
    expect(TestWorker.all).toHaveLength(1);
  });

  it("charges compressed sample-rate conversion using STREAMINFO rate", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    const { deviceAudioRequest } = await import("../browser-jobs");
    replyToAdmittedJobs();
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(compressedFile(), "48000") })).resolves.toHaveProperty("status", 200);
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(compressedFile(), "96000") })).rejects.toThrow("memory budget");
    expect(TestWorker.all).toHaveLength(1);
  });

  it("cancels during compressed preflight without cloning input or retaining its reservation", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const { deviceAudioRequest, reserveBrowserAudioMemory } = await import("../browser-jobs");
    const controller = new AbortController(), file = compressedFile(), read = vi.spyOn(file, "arrayBuffer");
    const form = new FormData(); form.append("file", file);
    const slice = file.slice.bind(file);
    vi.spyOn(file, "slice").mockImplementation((...args) => { controller.abort(); return slice(...args); });
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => { const owner = reserveBrowserAudioMemory(192 * 1024 * 1024); owner.dispose(); });
    expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(0);
  });

  it("checks cancellation while walking MP3 headers across successive chunks", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const controller = new AbortController(), frames = mp3Frames();
    const file = new File(Array.from({ length: 600 }, () => frames), "long.mp3"), slice = file.slice.bind(file);
    const read = vi.spyOn(file, "arrayBuffer"), chunks = vi.spyOn(file, "slice").mockImplementation((...args) => {
      if ((args[0] ?? 0) > 0) controller.abort();
      return slice(...args);
    });
    const form = new FormData(); form.append("file", file);
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: form, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(chunks.mock.calls.length).toBeGreaterThan(1);
    expect(chunks.mock.calls.every(([start, end]) => (end ?? 0) - (start ?? 0) <= 65_536)).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(TestWorker.all).toHaveLength(0);
  });

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
      const index = TestWorker.all.length;
      const pending = deviceAudioRequest("/api/master/render", { method: "POST", body: render(paddedSource(48000, 4_194_304), sampleRate) });
      await waitFor(() => { expect(TestWorker.all.at(index)?.message).toBeDefined(); });
      const delays = timer.mock.calls.map(([, delay]) => delay ?? 0).filter((delay) => delay >= 100_000);
      TestWorker.all.at(index)?.reply(); await pending;
      return delays;
    };
    expect(await deadline()).toEqual([130_000]);
    expect(await deadline("48000")).toEqual([130_000]);
    expect(await deadline("44100")).toEqual([325_000]);
    expect(await deadline("96000")).toEqual([520_000]);
    timer.mockRestore();
  });

  it("mirrors the native delivered true-peak header from the render metrics", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const pending = deviceAudioRequest("/api/master/render", { method: "POST", body: render(source(), "44100") });
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const worker = TestWorker.all[0];
    const json = JSON.stringify({ status: "ok", sampleRate: 44100, afterMetrics: { truePeakDbtp: -1.004 } });
    worker?.onmessage?.({ data: { abi: "1.0", kind: "result", id: worker.message?.id, json, audio: new ArrayBuffer(52) } } as MessageEvent<unknown>);
    const response = await pending;
    expect(response.headers.get("X-Aurialis-After-Peak-dBTP")).toBe("-1.00");
    expect(response.headers.get("X-Aurialis-Source-Metrics")).toBe(json);
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

  it("preempts background loudness measurements so a foreground export never reports busy (V1-11)", async () => {
    const { deviceAudioRequest } = await import("../browser-jobs");
    const running = deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) }, undefined, "background").then(() => undefined, (error: unknown) => error);
    await waitFor(() => { expect(TestWorker.all[0]?.message).toBeDefined(); });
    const queued = deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) }, undefined, "background").then(() => undefined, (error: unknown) => error);
    const exported = deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) });
    expect(await running).toMatchObject({ name: "AbortError" });
    expect(await queued).toMatchObject({ name: "AbortError" });
    expect(TestWorker.all[0]?.terminated).toBe(true);
    await waitFor(() => { expect(TestWorker.all[1]?.message).toBeDefined(); });
    expect(TestWorker.all).toHaveLength(2);
    TestWorker.all[1]?.reply();
    expect((await exported).status).toBe(200);
    // A background request never starts while user work is running or has just ended.
    const foreground = deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) });
    await waitFor(() => { expect(TestWorker.all[2]?.message).toBeDefined(); });
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) }, undefined, "background")).rejects.toMatchObject({ name: "AbortError" });
    TestWorker.all[2]?.reply(); await foreground;
    await expect(deviceAudioRequest("/api/master/render", { method: "POST", body: render(source()) }, undefined, "background")).rejects.toMatchObject({ name: "AbortError" });
    expect(TestWorker.all).toHaveLength(3);
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

  describe("native one-slot server (V1-11 Round E REQUIRED-2)", () => {
    // Emulates server.go: one audio POST at a time, immediate 503 + Retry-After
    // otherwise; an aborted upload releases the slot a little after the client gives up.
    function oneSlotServer(renderMs = 40, releaseMs = 30) {
      let busy = false; const statuses: number[] = [];
      vi.mocked(fetch).mockImplementation((_input, init) => new Promise<Response>((resolve, reject) => {
        if (init?.method !== "POST") { resolve(new Response("{}")); return; }
        if (busy) { statuses.push(503); resolve(new Response(JSON.stringify({ error: "busy" }), { status: 503, headers: { "Retry-After": "1" } })); return; }
        busy = true;
        const release = () => { setTimeout(() => { busy = false; }, releaseMs); };
        const done = setTimeout(() => { release(); statuses.push(200); resolve(new Response("{}")); }, renderMs);
        init.signal?.addEventListener("abort", () => { clearTimeout(done); release(); reject(new DOMException("The request was aborted.", "AbortError")); }, { once: true });
      }));
      return statuses;
    }
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native");
      vi.stubGlobal("location", { hostname: "127.0.0.1", origin: "http://127.0.0.1:8080" });
    });
    const post = () => ({ method: "POST", body: body() });

    it("aborts an in-flight background measurement and waits for the slot so Export never fails busy", async () => {
      const statuses = oneSlotServer();
      const { deviceAudioRequest } = await import("../browser-jobs");
      const measuring = deviceAudioRequest("/api/master/render", post(), undefined, "background").then(() => undefined, (error: unknown) => error);
      await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
      const exported = await deviceAudioRequest("/api/master/render", post());
      expect(exported.status).toBe(200);
      expect(await measuring).toMatchObject({ name: "AbortError" });
      expect(statuses.at(-1)).toBe(200);
    });

    it("never starts a background measurement while a foreground job holds the slot or just released it", async () => {
      oneSlotServer();
      const { deviceAudioRequest, withForegroundAudio } = await import("../browser-jobs");
      let inside: unknown;
      await withForegroundAudio(async () => {
        inside = await deviceAudioRequest("/api/master/render", post(), undefined, "background").then(() => undefined, (error: unknown) => error);
      });
      expect(inside).toMatchObject({ name: "AbortError" });
      // Multi-stage work (Deep analysis then compile) keeps priority across its short gaps.
      const between = await deviceAudioRequest("/api/master/render", post(), undefined, "background").then(() => undefined, (error: unknown) => error);
      expect(between).toMatchObject({ name: "AbortError" });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps priority through a whole native Deep analysis job, including its polling", async () => {
      const { deviceAudioRequest } = await import("../browser-jobs");
      const { runAudioJob } = await import("../audio-jobs");
      let duringPoll: unknown;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ jobId: "job-1", status: "queued", progress: 0, stage: "Queued" }));
        if (init?.method === "DELETE") return new Response("{}");
        duringPoll = await deviceAudioRequest("/api/master/render", { method: "POST", body: body() }, undefined, "background").then(() => undefined, (error: unknown) => error);
        expect(typeof input === "string" ? input : "").toContain("/api/jobs/job-1");
        return new Response(JSON.stringify({ jobId: "job-1", status: "done" }));
      });
      await runAudioJob("/api/analyze/deep", new FormData(), new AbortController().signal, () => undefined, (job) => job.status);
      expect(duringPoll).toMatchObject({ name: "AbortError" });
      expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    });

    it("surfaces a native preemption to the measurement caller as AbortError, not as an unreachable server", async () => {
      oneSlotServer();
      const { withForegroundAudio } = await import("../browser-jobs");
      const { measureRender } = await import("../browser-engine");
      let refused: unknown;
      await withForegroundAudio(async () => { refused = await measureRender(source(), { params: {} }, undefined, "background").then(() => undefined, (error: unknown) => error); });
      expect(refused).toMatchObject({ name: "AbortError" });
    });

    it("reports a native 503 to a background measurement as a retryable preemption, not a failure", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 503, headers: { "Retry-After": "1" } }));
      const { deviceAudioRequest } = await import("../browser-jobs");
      await expect(deviceAudioRequest("/api/master/render", post(), undefined, "background")).rejects.toMatchObject({ name: "AbortError" });
    });
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

describe("retained-audio memory advice", () => {
  it.each([
    { mode: "browser", hostname: "aurialis.yosefgamble.com", advice: "use the native Aurialis build", absent: "Download or discard" },
    { mode: "native loopback", hostname: "127.0.0.1", advice: "Download or discard finished audio", absent: "native Aurialis build" },
  ])("gives $mode advice when the tab's audio budget is full", async ({ hostname, advice, absent }) => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native");
    vi.stubGlobal("location", { hostname, origin: `http://${hostname}` });
    const { reserveBrowserAudioMemory } = await import("../browser-jobs");
    const failure = (() => { try { reserveBrowserAudioMemory(4 * 1024 * 1024 * 1024); return null; } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(advice);
    expect((failure as Error).message).not.toContain(absent);
  });
});
