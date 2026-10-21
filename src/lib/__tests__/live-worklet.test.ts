import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  ready: boolean;
  failed: boolean;
  sequence: number;
  controlVersion: number;
  memoryBuffer: ArrayBuffer;
};

// This VM kernel only tests protocol/lifecycle behavior. Compiled Go signal
// parity is covered independently by the native/WASI verification script.
function workletFixture(initialOdd = false) {
  let Constructor: (new (options: unknown) => Processor) | undefined;
  const header = new Int32Array(new SharedArrayBuffer(8 * 4));
  const tags = new Int32Array(new SharedArrayBuffer(256 * 5 * 4));
  const samples = new Float32Array(new SharedArrayBuffer(128 * 256 * 4 * 4));
  const controlHeader = new Int32Array(new SharedArrayBuffer(464), 0, 4);
  const values = new Float64Array(controlHeader.buffer, 16, 56);
  header[2] = 1; controlHeader[0] = initialOdd ? 1 : 2; controlHeader[1] = 1; values[3] = 2;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  let gain = 1;
  const processGo = () => {
    const left = new Float32Array(memory.buffer, 512, 128), right = new Float32Array(memory.buffer, 1024, 128);
    const outLeft = new Float32Array(memory.buffer, 1536, 128), outRight = new Float32Array(memory.buffer, 2048, 128);
    for (let index = 0; index < 128; index++) {
      outLeft.set([(left.at(index) ?? 0) * gain], index);
      outRight.set([(right.at(index) ?? 0) * gain], index);
    }
    return 128;
  };
  const applyGo = () => { gain = new Float64Array(memory.buffer, 2560, 56).at(3) ?? 0; return 1; };
  const kernel = {
    memory, _initialize: vi.fn(), aurialis_init: vi.fn(() => 1),
    aurialis_live_buffer: vi.fn((channel: number) => [512, 1024, 1536, 2048].at(channel) ?? 0),
    aurialis_control_buffer: vi.fn(() => 2560), aurialis_set_controls: vi.fn(applyGo),
    aurialis_live_process: vi.fn(processGo), aurialis_live_reset: vi.fn(() => 1),
  };
  const host = { imports: {}, attach: vi.fn(), beginRender: vi.fn() };
  const load = vi.fn((array: Int32Array, index: number) => Atomics.load(array, index));
  const wait = vi.fn(() => { throw new Error("The render thread must never wait"); });
  const context = {
    sampleRate: 48000, currentTime: 0, Int32Array, Float32Array, Float64Array, SharedArrayBuffer, Error,
    Atomics: { load, store: Atomics.store, add: Atomics.add, wait },
    WebAssembly: { Memory: WebAssembly.Memory, Instance: class { exports = kernel; } },
    createAurialisWasiHost: vi.fn(() => host),
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: vi.fn() }; },
    registerProcessor: (_name: string, value: new (options: unknown) => Processor) => { Constructor = value; },
  };
  const code = readFileSync("public/worklets/aurialis-live-worklet.js", "utf8").replace(/^import .*;$/m, "");
  runInNewContext(code, context);
  if (!Constructor) throw new Error("Audio worklet was not installed");
  const processor = new Constructor({ processorOptions: { header: header.buffer, tags: tags.buffer,
    samples: samples.buffer, controls: controlHeader.buffer, delayBlocks: 1, module: {},
    entropy: new Uint8Array(256), clockOriginMs: 1 } });
  const message = (data: unknown) => { processor.port.onmessage({ data }); };
  const render = (left = 0.25, right = 0.5) => {
    const output = [new Float32Array(128), new Float32Array(128)];
    expect(processor.process([[new Float32Array(128).fill(left), new Float32Array(128).fill(right)]], [output])).toBe(true);
    context.currentTime += 128 / context.sampleRate;
    return output;
  };
  return { context, header, tags, samples, controlHeader, values, memory, kernel, host, processor,
    load, wait, processGo, applyGo, message, render };
}

const silent = (output: Float32Array[]) => output.every(channel => channel.every(sample => sample === 0));

describe("direct Go worklet lifecycle", () => {
  it("warms and resets before ready, then stays dormant without erasing cumulative misses", () => {
    const f = workletFixture();
    expect(f.host.attach).toHaveBeenCalledWith(f.memory);
    expect(f.host.beginRender).toHaveBeenCalledOnce();
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(256);
    expect(f.kernel.aurialis_live_reset).toHaveBeenCalledOnce();
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "ready" });
    f.header[6] = 3;
    for (let block = 0; block < 100; block++) expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(256);
    expect(Array.from(f.header)).toEqual([0, 0, 1, 0, 0, 0, 3, 0]);
    expect(f.wait).not.toHaveBeenCalled();
    f.message({ type: "reset", generation: 1 });
    expect(f.header[6]).toBe(3);
  });
  it("publishes current Go output/version and renders the aligned preceding quantum", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    expect(silent(f.render())).toBe(true);
    expect(f.header[0]).toBe(1); expect(f.header[1]).toBe(1); expect(f.header[4]).toBe(0);
    expect([f.tags[512], f.tags[768], f.tags[1024]]).toEqual([1, 1, 1]);
    const output = f.render();
    expect(output[0]?.every(value => value === 0.5)).toBe(true);
    expect(output[1]?.every(value => value === 1)).toBe(true);
    expect(f.header[4]).toBe(1);
    expect(f.header[6]).toBe(0);
    f.message({ type: "original", value: true });
    for (let block = 0; block < 4; block++) f.render();
    const dry = f.render();
    expect(dry[0]?.every(value => value === 0.25)).toBe(true);
    expect(dry[1]?.every(value => value === 0.5)).toBe(true);
  });
  it("retains the old chain and version for a torn values-and-version transaction without spinning", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    f.render();
    f.kernel.aurialis_set_controls.mockClear();
    f.controlHeader[0] = 4; f.controlHeader[1] = 2; f.values[3] = 5;
    let sequenceReads = 0;
    f.load.mockImplementation((array, index) => {
      if (array.buffer === f.controlHeader.buffer && index === 0 && ++sequenceReads === 2) {
        Atomics.store(f.controlHeader, 0, 5); f.values[3] = 7;
        Atomics.store(f.controlHeader, 1, 3); Atomics.store(f.controlHeader, 0, 6);
      }
      return Atomics.load(array, index);
    });
    const before = f.render();
    expect(sequenceReads).toBe(2);
    expect(f.kernel.aurialis_set_controls).not.toHaveBeenCalled();
    expect(f.processor.controlVersion).toBe(1);
    expect(f.tags[1025]).toBe(1);
    expect(before[0]?.every(value => value === 0.5)).toBe(true);
    f.render();
    expect(f.kernel.aurialis_set_controls).toHaveBeenCalledOnce();
    expect(f.processor.controlVersion).toBe(3);
    const updated = f.render();
    expect(updated[0]?.every(value => value === 1.75)).toBe(true);
    expect(f.header[4]).toBe(3);
  });
  it("defers startup while a writer is busy and finishes readiness in a later inactive quantum", () => {
    const f = workletFixture(true);
    expect(f.processor.ready).toBe(false);
    expect(f.kernel.aurialis_live_process).not.toHaveBeenCalled();
    expect(silent(f.render())).toBe(true);
    expect(f.processor.port.postMessage).not.toHaveBeenCalled();
    Atomics.store(f.controlHeader, 0, 2);
    expect(silent(f.render())).toBe(true);
    expect(f.processor.ready).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(256);
    expect(f.processor.port.postMessage).toHaveBeenCalledTimes(1);
    expect(f.header[0]).toBe(0);
  });
  it("refreshes memory after controls before copying input and after processing before reading output", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    const originalBuffer = f.memory.buffer;
    f.controlHeader[0] = 4; f.controlHeader[1] = 2; f.values[3] = 3;
    f.kernel.aurialis_set_controls.mockImplementationOnce(() => { const result = f.applyGo(); f.memory.grow(1); return result; });
    f.kernel.aurialis_live_process.mockImplementationOnce(() => { f.memory.grow(1); return f.processGo(); });
    f.render();
    expect(originalBuffer.byteLength).toBe(0);
    expect(f.processor.memoryBuffer).toBe(f.memory.buffer);
    expect(f.samples[2 * 128 * 256]).toBe(0.75);
    expect(f.header[1]).toBe(1);
    const output = f.render();
    expect(output[0]?.every(value => value === 0.75)).toBe(true);
    expect(f.header[4]).toBe(2);
  });
  it.each(["reject", "trap"] as const)("fails immediately on a Go %s without a dry fallback or resetting misses", (failure) => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    f.message({ type: "original", value: true });
    for (let block = 0; block < 5; block++) f.render();
    f.header[6] = 7;
    f.kernel.aurialis_live_process.mockImplementationOnce(() => {
      if (failure === "trap") throw new Error("kernel trap");
      return 0;
    });
    expect(silent(f.render())).toBe(true);
    expect(f.processor.failed).toBe(true);
    expect(f.header[5]).toBe(1);
    expect(f.header[6]).toBe(7);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    const calls = f.kernel.aurialis_live_process.mock.calls.length;
    expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(calls);
  });
  it.each(["controls", "reset"] as const)("stops before processing when Go rejects %s", (operation) => {
    const f = workletFixture();
    f.header[6] = 3;
    f.kernel.aurialis_live_process.mockClear();
    if (operation === "controls") {
      f.message({ type: "reset", generation: 1 });
      f.controlHeader[0] = 4; f.controlHeader[1] = 2;
      f.kernel.aurialis_set_controls.mockReturnValueOnce(0);
    } else f.kernel.aurialis_live_reset.mockReturnValueOnce(0);
    if (operation === "reset") f.message({ type: "reset", generation: 1 });
    expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).not.toHaveBeenCalled();
    expect(f.processor.failed).toBe(true);
    expect(f.header[5]).toBe(1);
    expect(f.header[6]).toBe(3);
    expect(f.processor.controlVersion).toBe(1);
  });
  it("ignores stale and duplicate resets and starts a new generation exactly once", () => {
    const f = workletFixture();
    f.kernel.aurialis_live_reset.mockClear();
    f.message({ type: "reset", generation: 0 });
    expect(f.kernel.aurialis_live_reset).not.toHaveBeenCalled();
    f.message({ type: "reset", generation: 1 });
    f.render(); f.render();
    f.message({ type: "reset", generation: 1 });
    expect(f.processor.sequence).toBe(2);
    expect(f.kernel.aurialis_live_reset).toHaveBeenCalledOnce();
    Atomics.store(f.header, 2, 2); Atomics.store(f.header, 0, 0); Atomics.store(f.header, 1, 0);
    f.message({ type: "reset", generation: 1 });
    f.message({ type: "reset", generation: 2 });
    f.message({ type: "reset", generation: 2 });
    expect(f.kernel.aurialis_live_reset).toHaveBeenCalledTimes(2);
    expect(f.processor.sequence).toBe(0);
    f.render();
    expect(f.tags[768]).toBe(2);
  });
  it("does not publish old output if the generation changes inside the Go call", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    f.kernel.aurialis_live_process.mockImplementationOnce(() => { const result = f.processGo(); Atomics.store(f.header, 2, 2); return result; });
    expect(silent(f.render())).toBe(true);
    expect(f.header[1]).toBe(0);
    expect(f.tags[512]).toBe(0);
    expect(f.header[4]).toBe(0);
  });
  it("retains cumulative misses and the existing 200 ms consecutive-missing failure policy", () => {
    const f = workletFixture();
    f.header[6] = 3;
    f.message({ type: "reset", generation: 1 });
    f.load.mockImplementation((array, index) => array.buffer === f.tags.buffer && index >= 512 && index < 768 ? 0 : Atomics.load(array, index));
    f.render();
    for (let block = 0; block < 75; block++) expect(silent(f.render())).toBe(true);
    expect(f.header[6]).toBe(78);
    expect(f.processor.failed).toBe(false);
    expect(silent(f.render())).toBe(true);
    expect(f.header[6]).toBe(79);
    expect(f.processor.failed).toBe(true);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "error", message: "Live processing stalled. Pause and restart playback." });
  });
  it("ends at the exact sample and restores continuous output when the repeat gate is removed", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    f.render(0.5, 0.5);
    f.message({ type: "end", generation: 1, time: (128 + 17) / 48000 });
    const tail = f.render(0.5, 0.5);
    expect(Array.from(tail[0]?.subarray(0, 17) ?? [])).toEqual(Array<number>(17).fill(1));
    expect(tail.every(channel => channel.subarray(17).every(value => value === 0))).toBe(true);
    f.message({ type: "end", generation: 0, time: Infinity });
    expect(silent(f.render(0.5, 0.5))).toBe(true);
    f.message({ type: "end", generation: 1, time: Infinity });
    expect(f.render(0.5, 0.5).every(channel => channel.every(value => value === 1))).toBe(true);
    expect(f.header[6]).toBe(0);
  });
});
