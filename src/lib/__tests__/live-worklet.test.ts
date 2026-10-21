import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type RenderProcessor = {
  port: { onmessage: (event: { data: unknown }) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

describe("worklet audible cycle boundary", () => {
  it("ends at the exact sample within a quantum and removes the gate when repeat is enabled", () => {
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
    // A stale generation cannot remove the transport boundary.
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
