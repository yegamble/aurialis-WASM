import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Energy = { type: string; frames: number; squares: number; left?: number[]; right?: number[] };
type Processor = { port: { onmessage: (event: { data: { frames: number; coefficients: number[][] | null } }) => void }; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
/** Exercise the shipped test observer even when its main-thread reader never drains messages. */
describe("audio-thread speaker measurement", () => {
  it.each([null, [[1, 0, 0, 0, 0], [1, 0, 0, 0, 0]]])("measures exactly the requested contiguous frames (filters=%s)", (coefficients) => {
    const messages: Energy[] = [];
    let create: (new () => Processor) | undefined;
    runInNewContext(readFileSync("e2e/support/actual-output-tap.js", "utf8"), {
      AudioWorkletProcessor: class { port = { onmessage: () => undefined, postMessage: (message: Energy) => { messages.push(message); } }; },
      currentTime: 0, registerProcessor: (name: string, constructor: new () => Processor) => { if (name === "qa-live-output") create = constructor; },
    });
    if (!create) throw new Error("Missing test speaker processor");
    const tap = new create();
    tap.port.onmessage({ data: { frames: 1000, coefficients } });
    let expected = 0;
    for (let block = 0; block < 12; block++) {
      const left = Float32Array.from({ length: 128 }, (_, i) => ((block * 128 + i) % 17 - 8) / 16);
      const right = Float32Array.from(left, (sample) => -sample / 2);
      for (let i = 0; i < Math.min(128, Math.max(0, 1000 - block * 128)); i++) expected += (left.at(i) ?? 0) ** 2 + (right.at(i) ?? 0) ** 2;
      expect(tap.process([[left, right]], [[new Float32Array(128), new Float32Array(128)]])).toBe(true);
    }
    // Reader was blocked for all twelve blocks; the audio thread still counted every requested frame once.
    expect(messages.filter((message) => message.type === "energy")).toEqual([{ type: "energy", frames: 1000, squares: expected }]);
    const snapshot = messages.find((message) => message.type === "level");
    expect(snapshot?.left).toHaveLength(1024); expect(snapshot?.right).toHaveLength(1024);
    expect(snapshot?.left).toEqual(Array.from({ length: 1024 }, (_, index) => (index % 17 - 8) / 16));
  });
});
