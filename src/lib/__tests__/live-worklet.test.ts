import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type RenderProcessor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (message: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

function workletFixture() {
  let Processor: (new (options: unknown) => RenderProcessor) | undefined;
  const context = { sampleRate: 48000, currentTime: 0,
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: vi.fn() }; },
    registerProcessor: (_name: string, constructor: new (options: unknown) => RenderProcessor) => { Processor = constructor; } };
  runInNewContext(readFileSync("public/worklets/aurialis-live-worklet.js", "utf8"), context);
  if (!Processor) throw new Error("Audio worklet was not installed");
  const header = new Int32Array(new SharedArrayBuffer(8 * 4));
  const tags = new Int32Array(new SharedArrayBuffer(256 * 5 * 4));
  const samples = new Float32Array(new SharedArrayBuffer(128 * 256 * 4 * 4));
  header[2] = 1;
  const processor = new Processor({ processorOptions: { header: header.buffer,
    tags: tags.buffer, samples: samples.buffer, delayBlocks: 1 } });
  return { context, header, tags, samples, processor };
}

describe("worklet stream lifecycle", () => {
  it("keeps an unstarted graph dormant and preserves real active deadline failures", () => {
    const { context, header, processor } = workletFixture();
    const wake = vi.fn();
    processor.port.onmessage({ data: { type: "connect", port: { start: vi.fn(), postMessage: wake } } });
    const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
    header[6] = 3;
    for (let block = 0; block < 100; block++) {
      context.currentTime = block * 128 / context.sampleRate;
      processor.process([], [output]);
    }
    expect(header[0]).toBe(0);
    expect(header[1]).toBe(0);
    expect(header[7]).toBe(0);
    expect(header[6]).toBe(3);
    expect(wake).not.toHaveBeenCalled();
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    expect(output.every(channel => channel.every(sample => sample === 0))).toBe(true);
    // An explicit controller reset starts real deadlines, without erasing any
    // earlier misses. No fake worker results are published for these blocks.
    processor.port.onmessage({ data: { type: "reset", generation: 1 } });
    expect(header[6]).toBe(3);
    for (let block = 0; block < 100; block++) processor.process([], [output]);
    expect(header[6]).toBeGreaterThan(3);
    expect(wake).toHaveBeenCalled();
    expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(output.every(channel => channel.every(sample => sample === 0))).toBe(true);
    const finalWritten = header[0];
    processor.process([], [output]);
    expect(header[0]).toBe(finalWritten);
  });

  it("ends at the exact sample within a quantum and removes the gate when repeat is enabled", () => {
    const { context, header, tags, samples, processor } = workletFixture();
    processor.port.onmessage({ data: { type: "reset", generation: 1 } });
    const output = [new Float32Array(128), new Float32Array(128)];
    const render = (sequence: number) => {
      const offset = (sequence - 1) * 128;
      samples.fill(1, 2 * 128 * 256 + offset, 2 * 128 * 256 + offset + 128);
      samples.fill(1, 3 * 128 * 256 + offset, 3 * 128 * 256 + offset + 128);
      tags[2 * 256 + sequence - 1] = sequence;
      tags[3 * 256 + sequence - 1] = 1;
      processor.process([], [output]);
    };
    // First quantum primes the aligned delay. A stop 17 samples into the next
    // quantum must retain all 17 samples and expose none from the next cycle.
    processor.process([], [output]);
    context.currentTime = 128 / 48000;
    processor.port.onmessage({ data: { type: "end", generation: 1, time: (128 + 17) / 48000 } });
    render(1);
    expect(Array.from(output[0]?.subarray(0, 17) ?? [])).toEqual(Array<number>(17).fill(1));
    expect(output.every(channel => channel.subarray(17).every(sample => sample === 0))).toBe(true);
    context.currentTime = 256 / 48000;
    processor.port.onmessage({ data: { type: "end", generation: 0, time: Infinity } });
    render(2);
    expect(output.every(channel => channel.every(sample => sample === 0))).toBe(true);
    processor.port.onmessage({ data: { type: "end", generation: 1, time: Infinity } });
    context.currentTime = 384 / 48000;
    render(3);
    expect(output.every(channel => channel.every(sample => sample === 1))).toBe(true);
    expect(header[6]).toBe(0);
  });
});
