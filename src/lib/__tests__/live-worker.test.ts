import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Harness = {
  reset: (generation?: number) => void;
  pump: () => void;
  setBuffers: (header: Int32Array, tags: Int32Array, samples: Float32Array) => void;
};

describe("worker generation ordering", () => {
  it("warms only a bounded configured Go chain before resetting for real source audio", async () => {
    const events: string[] = [];
    const process = vi.fn((left: Float32Array, right: Float32Array) => {
      expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
      expect(left.some(value => value !== 0) && right.some(value => value !== 0)).toBe(true);
      return 128;
    });
    const scope = {
      Go: class { importObject = {}; run() { return Promise.resolve(); } },
      aurialisDSPReady: true,
      aurialisDSPInit: () => { events.push("init"); return true; },
      aurialisDSPSetParams: () => { events.push("params"); return true; },
      aurialisDSPProcessBlock: process,
      aurialisDSPReset: () => { events.push("reset"); return true; },
      postMessage: (message: { type: string }) => { events.push(message.type); },
      onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined,
    };
    const context = { self: scope, importScripts: vi.fn(),
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
      WebAssembly: { instantiate: () => Promise.resolve({ instance: {} }) }, setTimeout: vi.fn() };
    const script = readFileSync("public/workers/aurialis-live-worker.js", "utf8");
    runInNewContext(script, context);
    const header = new Int32Array(new SharedArrayBuffer(8 * 4));
    header[2] = 1;
    await scope.onmessage?.({ data: { type: "init", sampleRate: 48000, params: "{}", version: 1,
      header: header.buffer, tags: new SharedArrayBuffer(256 * 5 * 4),
      samples: new SharedArrayBuffer(128 * 256 * 4 * 4), port: { start: vi.fn() } } });
    expect(process).toHaveBeenCalledTimes(256);
    expect(events).toEqual(["init", "params", "reset", "ready"]);
  });
  it("does not rewind DSP or the read cursor when a delayed reset follows a new-generation wake", async () => {
    const reset = vi.fn(() => true);
    const scope = {
      aurialisDSPReset: reset,
      aurialisDSPProcessBlock: (left: Float32Array, right: Float32Array, outputLeft: Float32Array, outputRight: Float32Array) => {
        outputLeft.set(left); outputRight.set(right); return left.length;
      },
      postMessage: vi.fn(),
      onmessage: undefined as ((event: { data: { type: string; generation: number } }) => Promise<void>) | undefined,
    };
    const context = { self: scope, setTimeout: vi.fn(), probe: undefined as Harness | undefined };
    // The script is a fixed, trusted repository asset; it runs against isolated
    // fake DSP callbacks to test protocol ordering, not DSP signal correctness.
    const script = readFileSync("public/workers/aurialis-live-worker.js", "utf8");
    runInNewContext(script + "\nprobe={reset,pump,setBuffers(h,t,s){header=h;tags=t;samples=s;version=1;}};", context);
    const harness = context.probe;
    if (!harness || !scope.onmessage) throw new Error("Worker protocol was not installed");
    const header = new Int32Array(new SharedArrayBuffer(8 * 4));
    const tags = new Int32Array(new SharedArrayBuffer(256 * 5 * 4));
    const samples = new Float32Array(new SharedArrayBuffer(128 * 256 * 4 * 4));
    harness.setBuffers(header, tags, samples);
    header[2] = 2; header[0] = 1; tags[0] = 1; tags[256] = 2;
    harness.pump();
    expect(header[1]).toBe(1);
    expect(reset).toHaveBeenCalledTimes(1);
    await scope.onmessage({ data: { type: "reset", generation: 2 } });
    expect(header[1]).toBe(1);
    expect(reset).toHaveBeenCalledTimes(1);
    await scope.onmessage({ data: { type: "reset", generation: 1 } });
    expect(header[1]).toBe(1);
    header[2] = 3; header[1] = 0; tags[256] = 3;
    harness.pump();
    expect(header[1]).toBe(1);
    expect(reset).toHaveBeenCalledTimes(2);
    await scope.onmessage({ data: { type: "reset", generation: 3 } });
    expect(header[1]).toBe(1);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
