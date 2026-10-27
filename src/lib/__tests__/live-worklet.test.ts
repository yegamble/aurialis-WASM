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
function workletFixture(initialOdd = false, abiVersion: number | null = 1, capability: "count" | "algorithm" | "latency" | "missing" | null = null, sharedEpoch = false, latency = 0) {
  let Constructor: (new (options: unknown) => Processor) | undefined;
  const header = new Int32Array(new SharedArrayBuffer(8 * 4));
  const tags = new Int32Array(new SharedArrayBuffer(256 * 5 * 4));
  const epoch = new SharedArrayBuffer(24); const epochHeader = new Int32Array(epoch, 0, 2); const epochTime = new Float64Array(epoch, 8, 2);
  epochTime[1] = Infinity;
  const samples = new Float32Array(new SharedArrayBuffer(128 * 256 * 4 * 4));
  const controlHeader = new Int32Array(new SharedArrayBuffer(16 + (abiVersion === 1 ? 81 : 82) * 8), 0, 4);
  const values = new Float64Array(controlHeader.buffer, 16, abiVersion === 1 ? 81 : 82);
  header[2] = 1; controlHeader[0] = initialOdd ? 1 : 2; controlHeader[1] = 1; values[3] = 2;
  if (abiVersion === 2) values[81] = 1;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  let gain = 1;
  let revision = 0, pendingRevision = 0, pendingGain = 1;
  // Like the export algorithm's lookahead, processed audio leaves `latency` frames late.
  const pipeline = [new Float32Array(latency), new Float32Array(latency)];
  let pipelineAt = 0;
  const processGo = () => {
    const left = new Float32Array(memory.buffer, 512, 128), right = new Float32Array(memory.buffer, 1024, 128);
    const outLeft = new Float32Array(memory.buffer, 1536, 128), outRight = new Float32Array(memory.buffer, 2048, 128);
    for (let index = 0; index < 128; index++) {
      let l = (left.at(index) ?? 0) * gain, r = (right.at(index) ?? 0) * gain;
      if (latency > 0) {
        const delayedL = pipeline[0]?.at(pipelineAt) ?? 0, delayedR = pipeline[1]?.at(pipelineAt) ?? 0;
        pipeline[0]?.set([l], pipelineAt); pipeline[1]?.set([r], pipelineAt);
        pipelineAt = (pipelineAt + 1) % latency; l = delayedL; r = delayedR;
      }
      outLeft.set([l], index);
      outRight.set([r], index);
    }
    return 128;
  };
  const applyGo = () => { gain = new Float64Array(memory.buffer, 2560, 81).at(3) ?? 0; return 1; };
  const kernel = {
    aurialis_schedule_abi: vi.fn(() => 1),
    aurialis_schedule_source_buffer: vi.fn(() => 4096), aurialis_schedule_move_buffer: vi.fn(() => 8192),
    aurialis_schedule_bind_source: vi.fn(() => 1),
    aurialis_schedule_begin: vi.fn((next: number) => { pendingRevision = next; pendingGain = new Float64Array(memory.buffer, 2560, 82).at(3) ?? 1; return 1; }),
    aurialis_schedule_stage_move: vi.fn(() => 1),
    aurialis_schedule_commit: vi.fn(() => { revision = pendingRevision; gain = pendingGain; return 1; }),
    aurialis_schedule_revision: vi.fn(() => revision), aurialis_schedule_seek: vi.fn(() => 1),
    aurialis_schedule_detach: vi.fn(() => 1), aurialis_schedule_set_looping: vi.fn(() => 1),
    memory, _initialize: vi.fn(), aurialis_init: vi.fn(() => 1),
    aurialis_live_buffer: vi.fn((channel: number) => [512, 1024, 1536, 2048].at(channel) ?? 0),
    aurialis_control_buffer: vi.fn(() => 2560), aurialis_set_controls: vi.fn(applyGo),
    aurialis_live_process: vi.fn(processGo), aurialis_live_reset: vi.fn(() => 1),
    aurialis_control_count: capability === "missing" ? undefined : vi.fn((abi: number) => capability === "count" ? 99 : abi === 1 ? 81 : abi === 2 ? 82 : 0),
    aurialis_algorithm_supported: vi.fn((version: number) => capability === "algorithm" ? 0 : Number(version === 1 || version === 2)),
    // One delay block lets A be read at most 128 frames ahead of B.
    aurialis_latency_frames: vi.fn(() => capability === "latency" ? 129 : latency),
    aurialis_live_end_input: vi.fn((offset: number) => Number(offset >= 0 && offset <= 128)),
    aurialis_live_resume_input: vi.fn(() => 1),
    aurialis_live_tail_buffer: vi.fn((channel: number) => [8192, 10240].at(channel) ?? 0),
    aurialis_live_tail_frames: vi.fn(() => 0),
    aurialis_control_buffer_v2: vi.fn(() => 2560),
    aurialis_set_controls_v2: vi.fn((count: number) => count === 82 ? applyGo() : 0),
    aurialis_meter_buffer: vi.fn(() => 3328),
    aurialis_meter_snapshot: vi.fn(() => { new Float64Array(memory.buffer, 3328, 7).set([-14.2, -14.6, -200, -200, -0.8, -240, 2.5]); return 7; }),
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
    ...(sharedEpoch ? { stream: epoch } : {}), samples: samples.buffer, controls: controlHeader.buffer, delayBlocks: 1, module: {},
    entropy: new Uint8Array(256), clockOriginMs: 1, controlAbiVersion: abiVersion } });
  const message = (data: unknown) => { processor.port.onmessage({ data }); };
  const render = (left = 0.25, right = 0.5) => {
    const output = [new Float32Array(128), new Float32Array(128)];
    expect(processor.process([[new Float32Array(128).fill(left), new Float32Array(128).fill(right)]], [output])).toBe(true);
    context.currentTime += 128 / context.sampleRate;
    return output;
  };
  return { context, header, tags, samples, epochHeader, epochTime, controlHeader, values, memory, kernel, host, processor,
    load, wait, processGo, applyGo, message, render };
}

const OVERLOAD = "Playback can't keep up on this device with the current processing. Turn off some processing modules, or close other busy apps or tabs, then press Play.";
const FAULT = "Live playback lost its processed audio (an internal buffer fault, not a CPU limit). Press Play to restart, and reload the page if it happens again.";
const silent = (output: Float32Array[]) => output.every(channel => channel.every(sample => sample === 0));

describe("direct Go worklet lifecycle", () => {
  it.each([false, true])("binds the actual epoch looping=%s once, preserving it across schedule commits", (looping) => {
    const f = workletFixture(false, 2);
    f.message({ type: "bind-source", token: 1, source: new Float64Array([1, 8001, 129, 1, 2, 3, 4, 5, 6, 7, 8]) });
    expect(f.kernel.aurialis_schedule_set_looping).not.toHaveBeenCalled();
    f.message({ type: "arm", generation: 1, sourceFrame: 0, looping });
    expect(f.kernel.aurialis_schedule_set_looping).toHaveBeenCalledExactlyOnceWith(Number(looping));
    const gate = new SharedArrayBuffer(4); new Int32Array(gate)[0] = 1;
    f.message({ type: "schedule", token: 2, revision: 7, moveCount: 0, moves: new Float64Array(0), controls: new Float64Array(82), gate, deviceRate: 48000, version: 2 });
    f.render(); f.message({ type: "schedule-commit", token: 2 }); f.render();
    expect(f.kernel.aurialis_schedule_commit).toHaveBeenCalledOnce();
    expect(f.kernel.aurialis_schedule_set_looping).toHaveBeenCalledOnce();
  });
  it("posts the Go loudness snapshot with each 50 ms meter packet and fails on a missing snapshot", () => {
    const f = workletFixture(false, 2);
    f.message({ type: "reset", generation: 1, startTime: 0, sourceFrame: 0, looping: false });
    for (let block = 0; block < 19; block++) f.render();
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "meter",
      momentaryLufs: -14.2, shortTermLufs: -14.6, integratedLufs: null, loudnessRangeLu: null,
      truePeakDbtp: -0.8, recentTruePeakDbtp: -120, gainReductionDb: 2.5 }));
    f.kernel.aurialis_meter_snapshot.mockReturnValueOnce(0);
    for (let block = 0; block < 19; block++) f.render();
    expect(f.processor.failed).toBe(true);
  });
  it("uses an atomic shared audible deadline and accepts deadline updates after the epoch starts", () => {
    const f = workletFixture(false, 2, null, true);
    f.message({ type: "arm", generation: 1, sourceFrame: 0, looping: false });
    f.epochTime[0] = 0; f.epochTime[1] = 128 + 37; f.epochHeader[1] = 1; f.epochHeader[0] = 2;
    expect(silent(f.render())).toBe(true); const finite = f.render()[0];
    expect(finite?.slice(0, 37).every(value => value === .5)).toBe(true); expect(finite?.slice(37).every(value => value === 0)).toBe(true);
    f.epochTime[1] = Infinity; f.epochHeader[0] = 4;
    expect(f.render()[0]?.every(value => value === .5)).toBe(true); expect(f.processor.failed).toBe(false);
    f.epochTime[1] = 3 * 128 + 19; f.epochHeader[0] = 6;
    const stopped = f.render()[0]; expect(stopped?.slice(0, 19).every(value => value === .5)).toBe(true); expect(stopped?.slice(19).every(value => value === 0)).toBe(true);
  });

  it("marks the source's last input frame once, plays the drained tail while finite, and resumes without a reset (V1-13)", () => {
    // A 64-frame lookahead, like the export limiter's.
    const f = workletFixture(false, 2, null, true, 64);
    const endInput = vi.fn((offset: number) => Number(offset >= 0 && offset <= 128));
    // The drained tail: 64 frames of 0.75 where the engine plays 0.25/0.5.
    new Float32Array(f.memory.buffer, 8192, 512).fill(0.75); new Float32Array(f.memory.buffer, 10240, 512).fill(0.75);
    Object.assign(f.kernel, { aurialis_live_end_input: endInput, aurialis_live_tail_frames: vi.fn(() => 64) });
    f.message({ type: "arm", generation: 1, sourceFrame: 0, looping: false });
    // Audible until 3 × 128 + 37; with one delay block the input ends at 2 × 128 + 37.
    f.epochTime[0] = 0; f.epochTime[1] = 3 * 128 + 37; f.epochHeader[1] = 1; f.epochHeader[0] = 2;
    f.render(); f.render();
    expect(endInput).not.toHaveBeenCalled();
    // The tail replaces processed frames 293–356 (source frames 229–292), read
    // 64 frames ahead in the same quantum from output index 101.
    const heard = f.render()[0];
    expect(endInput).toHaveBeenCalledExactlyOnceWith(37);
    expect(Array.from(heard?.subarray(99, 102) ?? [])).toEqual([0.5, 0.5, 0.75]);
    const resets = f.kernel.aurialis_live_reset.mock.calls.length;
    f.epochTime[1] = Infinity; f.epochHeader[0] = 4;
    const resumed = f.render()[0];
    expect(f.kernel.aurialis_live_resume_input).toHaveBeenCalledOnce();
    expect(f.kernel.aurialis_live_reset).toHaveBeenCalledTimes(resets);
    expect(resumed?.every(value => value === 0.5)).toBe(true);
    expect(endInput).toHaveBeenCalledOnce();
    expect(f.processor.failed).toBe(false);
  });

  it.each(["revision", "commit"] as const)("fails closed when %s verification fails after commit", (failure) => {
    const f = workletFixture(false, 2);
    f.message({ type: "bind-source", token: 1, source: new Float64Array([1, 48000, 48000, 1, 2, 3, 4, 5, 6, 7, 8]) });
    f.message({ type: "reset", generation: 1, startTime: 0, sourceFrame: 0, looping: true });
    const controls = new Float64Array(82); controls[3] = 3; controls[81] = 1;
    const gate = new SharedArrayBuffer(4); new Int32Array(gate)[0] = 1;
    f.message({ type: "schedule", token: 2, revision: 7, moveCount: 0, moves: new Float64Array(0), controls, gate, deviceRate: 48000, version: 2 });
    f.render();
    if (failure === "revision") f.kernel.aurialis_schedule_revision.mockReturnValueOnce(99);
    else f.kernel.aurialis_schedule_commit.mockReturnValueOnce(0);
    f.message({ type: "schedule-commit", token: 2 }); expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_schedule_commit).toHaveBeenCalledOnce();
    expect(f.processor.failed).toBe(true);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(f.processor.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "automation-error" }));
  });
  it("paces one move per quantum and preserves the old chain until main-thread commit approval", () => {
    const f = workletFixture(false, 2);
    f.message({ type: "bind-source", token: 1, source: new Float64Array([1, 48000, 48000, 1, 2, 3, 4, 5, 6, 7, 8]) });
    f.message({ type: "reset", generation: 1, startTime: 0, sourceFrame: 0, looping: true });
    const controls = new Float64Array(82); controls[3] = 3; controls[81] = 1;
    const gate = new SharedArrayBuffer(4); new Int32Array(gate)[0] = 1;
    const moves = new Float64Array(3 * 516);
    for (let index = 0; index < 3; index++) moves.set([0, 2, 0, 0, index * 1000, 3, index * 1000 + 500, 3], index * 516);
    f.message({ type: "schedule", token: 2, revision: 7, moveCount: 3, moves, controls, gate, deviceRate: 48000, version: 2 });
    expect(f.kernel.aurialis_schedule_stage_move).not.toHaveBeenCalled();
    f.render(); expect(f.kernel.aurialis_schedule_stage_move).toHaveBeenCalledTimes(1);
    expect(f.render()[0]?.every(value => value === .5)).toBe(true);
    expect(f.kernel.aurialis_schedule_stage_move).toHaveBeenCalledTimes(2);
    f.render(); expect(f.kernel.aurialis_schedule_stage_move).toHaveBeenCalledTimes(3);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "automation-staged", token: 2 });
    expect(f.kernel.aurialis_schedule_commit).not.toHaveBeenCalled();
    f.render(); expect(f.kernel.aurialis_schedule_stage_move).toHaveBeenCalledTimes(3);
    f.message({ type: "schedule-commit", token: 2 }); f.render();
    expect(f.kernel.aurialis_schedule_commit).toHaveBeenCalledOnce();
    expect(f.kernel.aurialis_schedule_set_looping).toHaveBeenCalledWith(1);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "automation-ack", token: 2, revision: 7 });
    expect(f.render()[0]?.every(value => value === .75)).toBe(true);
    f.values[3] = 9; f.controlHeader[1] = 99; f.controlHeader[0] = 4; f.render();
    expect(f.kernel.aurialis_set_controls_v2).toHaveBeenCalledTimes(1);
    f.message({ type: "schedule", token: 3, revision: 8, moveCount: 3, moves, controls, gate, deviceRate: 48000, version: 3 });
    f.render(); f.message({ type: "schedule-cancel", token: 3 });
    for (let index = 0; index < 5; index++) f.render();
    expect(f.kernel.aurialis_schedule_commit).toHaveBeenCalledOnce();
  });
  it("holds the kernel and ring clock until the quantum-aligned source epoch, and during pause", () => {
    const f = workletFixture(); const warmed = f.kernel.aurialis_live_process.mock.calls.length;
    f.message({ type: "reset", generation: 1, startTime: 256 / 48000, sourceFrame: 123 });
    expect(silent(f.render())).toBe(true); expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed);
    expect(f.header[0]).toBe(0);
    f.render(); expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed + 1);
    f.message({ type: "hold" }); expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed + 1);
  });
  it("fails a reset delivered after its source deadline instead of processing shifted input at a stale seek", () => {
    const f = workletFixture(false, 2); const warmed = f.kernel.aurialis_live_process.mock.calls.length;
    f.context.currentTime = 4 * 128 / 48000;
    f.message({ type: "reset", generation: 1, startTime: 128 / 48000, sourceFrame: 123 });
    expect(f.processor.failed).toBe(true);
    expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed);
    expect(f.header[0]).toBe(0);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "The source start deadline was missed. Retry playback." }));
  });
  it("arms without consuming a delayed source prefix, then starts from a shared quantum epoch", () => {
    const f = workletFixture(false, 2, null, true); const warmed = f.kernel.aurialis_live_process.mock.calls.length;
    f.message({ type: "bind-source", token: 1, source: new Float64Array([1, 48000, 48000, 1, 2, 3, 4, 5, 6, 7, 8]) });
    for (let index = 0; index < 4; index++) f.render();
    f.message({ type: "arm", generation: 1, sourceFrame: 123 });
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "stream-armed", generation: 1 });
    expect(f.kernel.aurialis_schedule_seek).toHaveBeenCalledWith(123);
    for (let index = 0; index < 4; index++) expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed);
    f.epochTime[0] = 10 * 128; f.epochHeader[1] = 1; f.epochHeader[0] = 2;
    expect(silent(f.render())).toBe(true); expect(silent(f.render())).toBe(true);
    expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed);
    f.render(); expect(f.kernel.aurialis_live_process).toHaveBeenCalledTimes(warmed + 1); expect(f.header[0]).toBe(1);
  });
  it.each([0, 3, 1.5, null])("rejects explicit unsupported packet ABI %s", (abi) => {
    const f = workletFixture(false, abi);
    expect(f.processor.failed).toBe(true);
    expect(f.processor.ready).toBe(false);
    expect(f.kernel.aurialis_live_process).not.toHaveBeenCalled();
    expect(f.host.beginRender).not.toHaveBeenCalled();
  });
  it("negotiates the additive ABI without changing legacy packet playback", () => {
    const f = workletFixture(false, 2);
    expect(f.values.length).toBe(82);
    expect(f.processor.ready).toBe(true);
    expect(f.kernel.aurialis_control_count).toHaveBeenCalledWith(2);
    expect(f.kernel.aurialis_set_controls).not.toHaveBeenCalled();
    expect(f.kernel.aurialis_set_controls_v2).toHaveBeenCalledWith(82);
    f.message({ type: "reset", generation: 1 });
    f.render();
    expect(f.render()[0]?.every(value => value === .5)).toBe(true);
  });
  it("rejects a settings latency it cannot read ahead before warming or producing audio", () => {
    const f = workletFixture(false, 2, "latency");
    expect(f.processor.failed).toBe(true);
    expect(f.processor.ready).toBe(false);
    expect(f.kernel.aurialis_live_process).not.toHaveBeenCalled();
    expect(silent(f.render())).toBe(true);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "The live audio engine reported an unsupported latency." }));
  });
  it.each(["count", "algorithm", "missing"] as const)("rejects %s capability mismatch before warming or producing audio", (capability) => {
    const f = workletFixture(false, 1, capability);
    expect(f.processor.failed).toBe(true);
    expect(f.processor.ready).toBe(false);
    expect(f.kernel.aurialis_live_process).not.toHaveBeenCalled();
    expect(f.host.beginRender).not.toHaveBeenCalled();
    expect(silent(f.render())).toBe(true);
    expect(f.processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
  it("reads A the engine latency ahead of B, so A, B and the playhead share one source clock (V1-10)", () => {
    const f = workletFixture(false, 2, null, false, 40);
    expect(f.kernel.aurialis_latency_frames).toHaveBeenCalled();
    f.message({ type: "reset", generation: 1 });
    // Each source quantum has its own level, so a misaligned read would mix
    // the previous quantum's level into the first 40 frames of A.
    const levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const heard = levels.map(level => f.render(level, -level)[0]);
    for (const [quantum, output] of heard.slice(1).entries())
      expect(output?.every(value => value === Math.fround(2 * (levels.at(quantum) ?? 0)))).toBe(true);
    expect(f.header[6]).toBe(0);
    f.message({ type: "original", value: true });
    for (let block = 0; block < 4; block++) f.render(0.7);
    expect(f.render(0.8)[0]?.every(value => value === Math.fround(0.7))).toBe(true);
  });
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
  it("retains cumulative misses and reports 200 ms of missing processed audio as a buffer fault, not CPU", () => {
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
    // Missing output with the kernel run synchronously is a tag or generation fault.
    expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "error", message: FAULT });
  });
  // Thousands of rendered quanta: allow for a loaded host.
  describe("deadline watch (CPU overload)", { timeout: 60_000 }, () => {
    /** Play `seconds` of active audio with a fake wall clock: each quantum takes
     * `wallMs` of wall time, of which the kernel call takes `kernelMs`. */
    function play(f: ReturnType<typeof workletFixture>, seconds: number, wallMs: number, kernelMs: number, clock: { now: number }) {
      f.kernel.aurialis_live_process.mockImplementation(() => { clock.now += kernelMs; return f.processGo(); });
      const quanta = Math.round(seconds * 48000 / 128);
      for (let index = 0; index < quanta && !f.processor.failed; index++) { f.render(); clock.now += wallMs - kernelMs; }
    }
    function watched() {
      const f = workletFixture(), clock = { now: 1000 };
      Reflect.set(f.context, "Date", { now: () => clock.now });
      f.message({ type: "reset", generation: 1 });
      return { f, clock };
    }
    const quantumMs = 1000 * 128 / 48000;
    it("fires the overload message when the audio clock keeps falling behind the wall clock", () => {
      const { f, clock } = watched();
      play(f, 5, quantumMs * 1.2, 1, clock);
      expect(f.processor.failed).toBe(true);
      expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "error", message: OVERLOAD });
      expect(f.processor.port.postMessage).not.toHaveBeenCalledWith({ type: "error", message: FAULT });
    });
    it("fires when the kernel uses more than 90% of the audio it renders, even before the clock lags", () => {
      const { f, clock } = watched();
      play(f, 5, quantumMs, quantumMs * 0.95, clock);
      expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "error", message: OVERLOAD });
    });
    it("fires on a short hitch every second that averages out of the lag and load", () => {
      const { f, clock } = watched();
      const quanta = 375; // one second at 48 kHz
      let index = 0;
      f.kernel.aurialis_live_process.mockImplementation(() => { clock.now += index++ % quanta === 100 ? 60 : 1; return f.processGo(); });
      for (let block = 0; block < 5 * quanta && !f.processor.failed; block++) { f.render(); clock.now += quantumMs - 1; }
      expect(f.processor.port.postMessage).toHaveBeenCalledWith({ type: "error", message: OVERLOAD });
    });
    it("stays quiet for a kernel within budget, one host stall, one slow call and a pause gap", () => {
      const { f, clock } = watched();
      play(f, 2.5, quantumMs, quantumMs * 0.5, clock);
      clock.now += 900; // one stalled callback: a single late window, not two in a row
      play(f, 2.5, quantumMs, quantumMs * 0.5, clock);
      play(f, 128 / 48000, 6, 6, clock); // one 6 ms kernel call: a single missed window
      play(f, 2.5, quantumMs, quantumMs * 0.5, clock);
      f.message({ type: "hold" }); clock.now += 60_000;
      f.message({ type: "reset", generation: 1 });
      play(f, 2.5, quantumMs, quantumMs * 0.5, clock);
      expect(f.processor.failed).toBe(false);
      expect(f.processor.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    });
  });
  it("applies one static attenuate-only match gain to A or B, ramped once, without changing crest or contrast (V1-11)", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    f.render(0.25, 0.25);
    // The fake kernel doubles the input (+6.02 dB): A measures 6.02 LU louder than B.
    const gain = 0.5;
    f.message({ type: "match", processed: gain, original: 1 });
    for (let block = 0; block < 4; block++) f.render(0.25, 0.25);
    // Output is one quantum behind its input (delayBlocks 1).
    f.render(0.1, 0.1);
    const quiet = f.render(0.4, 0.4), loud = f.render(0.4, 0.4), settled = loud;
    // A after the match equals B: the doubled source halved.
    expect(settled.every(channel => channel.every(value => Math.abs(value - 0.4) < 1e-7))).toBe(true);
    expect(quiet[0]?.at(-1)).toBeCloseTo(0.1, 7);
    // Section contrast (quiet vs loud) is unchanged: a static gain scales both equally.
    expect(20 * Math.log10((loud[0]?.at(-1) ?? 0) / (quiet[0]?.at(-1) ?? 1))).toBeCloseTo(20 * Math.log10(4), 3);
    f.message({ type: "original", value: true });
    for (let block = 0; block < 4; block++) f.render(0.4, 0.4);
    expect(f.render(0.4, 0.4).every(channel => channel.every(value => value === Math.fround(0.4)))).toBe(true);
    // Attenuate-only: a boost, zero, negative or non-finite gain is ignored.
    for (const invalid of [1.5, 0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])
      f.message({ type: "match", processed: 1, original: invalid });
    for (let block = 0; block < 4; block++) f.render(0.4, 0.4);
    expect(f.render(0.4, 0.4).every(channel => channel.every(value => value === Math.fround(0.4)))).toBe(true);
    f.message({ type: "match", processed: 1, original: 0.5 });
    for (let block = 0; block < 4; block++) f.render(0.4, 0.4);
    expect(f.render(0.4, 0.4).every(channel => channel.every(value => Math.abs(value - 0.2) < 1e-7))).toBe(true);
  });
  it("meters the monitored level before the match gain, so peak, RMS and crest describe A or B, not the attenuation (V1-11)", () => {
    const f = workletFixture();
    f.message({ type: "reset", generation: 1 });
    const meters = () => f.processor.port.postMessage.mock.calls.map(([message]) => message as { type?: string; peakDbfs?: number; rmsDbfs?: number }).filter((message) => message.type === "meter");
    for (let block = 0; block < 40; block++) f.render(0.25, 0.25);
    const before = meters().at(-1);
    f.message({ type: "match", processed: 0.5, original: 1 });
    for (let block = 0; block < 40; block++) f.render(0.25, 0.25);
    const after = meters().at(-1);
    expect(before?.peakDbfs).toBeCloseTo(20 * Math.log10(0.5), 6);
    expect(after?.peakDbfs).toBeCloseTo(before?.peakDbfs ?? 0, 9);
    expect(after?.rmsDbfs).toBeCloseTo(before?.rmsDbfs ?? 0, 9);
    // The speakers still receive the matched level.
    expect(f.render(0.25, 0.25).every(channel => channel.every(value => Math.abs(value - 0.25) < 1e-7))).toBe(true);
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
