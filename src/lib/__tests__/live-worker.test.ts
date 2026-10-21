import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
type Probe = { reset: (generation?: number) => void; pump: () => void; pending: () => number };

function engineFixture() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const offsets = [1024, 2048, 3072, 4096];
  const events: string[] = [];
  function channel(index: number): Float32Array {
    const offset = offsets.at(index);
    if (offset === undefined) throw new Error("Unknown fixture channel");
    return new Float32Array(memory.buffer, offset, QUANTUM);
  }
  const process = vi.fn(() => { channel(2).set(channel(0)); channel(3).set(channel(1)); return QUANTUM; });
  const reset = vi.fn(() => { events.push("reset"); return 1; });
  const buffer = vi.fn((index: number) => offsets.at(index) ?? 0);
  return { memory, offsets, events, channel, process, reset, buffer,
    exports: { mem: memory, aurialis_live_buffer: buffer, aurialis_live_process: process, aurialis_live_reset: reset } };
}

function workerFixture(engine = engineFixture()) {
  let now = 0;
  const tasks = new Map<number, () => void>();
  const receivingPort = { start: vi.fn(), close: vi.fn(),
    onmessage: undefined as ((event: { data: number }) => void) | undefined };
  const sendingPort = { close: vi.fn(), postMessage: vi.fn((ticket: number) => {
    tasks.set(ticket, () => { receivingPort.onmessage?.({ data: ticket }); });
  }) };
  const wait = vi.fn((array: Int32Array, index: number, expected: number, timeout: number): "ok" | "not-equal" | "timed-out" => {
    if (Atomics.load(array, index) !== expected) return "not-equal";
    now += timeout;
    return "timed-out";
  });
  const store = vi.fn((array: Int32Array, index: number, value: number) => Atomics.store(array, index, value));
  const posted: { type: string; message?: string }[] = [];
  const legacyProcess = vi.fn(() => { throw new Error("Legacy processing callback was used"); });
  const legacyReset = vi.fn(() => { throw new Error("Legacy reset callback was used"); });
  const scope = {
    Go: class { importObject = {}; run() { return Promise.resolve(); } },
    aurialisDSPReady: true,
    aurialisDSPInit: vi.fn(() => { engine.events.push("init"); return true; }),
    aurialisDSPSetParams: vi.fn((_params: string) => { engine.events.push("params"); return true; }),
    aurialisDSPProcessBlock: legacyProcess,
    aurialisDSPReset: legacyReset,
    postMessage: (message: { type: string; message?: string }) => { engine.events.push(message.type); posted.push(message); },
    close: vi.fn(),
    onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined,
  };
  const context = { self: scope, importScripts: vi.fn(),
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
    WebAssembly: { Memory: WebAssembly.Memory, instantiate: () => Promise.resolve({ instance: { exports: engine.exports } }) },
    Atomics: { load: Atomics.load, store, wait }, performance: { now: () => now },
    MessageChannel: class { port1 = receivingPort; port2 = sendingPort; },
    setTimeout: vi.fn(() => { throw new Error("The live continuation must not depend on timers"); }),
    probe: undefined as Probe | undefined };
  // This fixed repository script uses isolated fake Go exports. These cases
  // verify its protocol and memory lifecycle, not DSP sample correctness.
  const script = readFileSync("public/workers/aurialis-live-worker.js", "utf8");
  runInNewContext(script + "\nprobe={reset,pump,pending:()=>continuation};", context);
  const probe = context.probe;
  if (!probe || !scope.onmessage) throw new Error("Worker protocol was not installed");
  const pendingTicket = probe.pending;
  const onmessage = scope.onmessage;
  const header = new Int32Array(new SharedArrayBuffer(8 * 4));
  const tags = new Int32Array(new SharedArrayBuffer(SLOTS * 5 * 4));
  const samples = new Float32Array(new SharedArrayBuffer(FRAMES * 4 * 4));
  header[2] = 1;
  const port = { start: vi.fn(), close: vi.fn(), onmessage: undefined };
  const message = (data: unknown) => onmessage({ data });
  const init = () => message({ type: "init", sampleRate: 48000, params: "{}", version: 1,
    header: header.buffer, tags: tags.buffer, samples: samples.buffer, port });
  function queue(sequence: number, generation: number) {
    if (header[2] !== generation) header[1] = 0;
    header[2] = generation;
    const slot = (sequence - 1) % SLOTS;
    const offset = slot * QUANTUM;
    samples.fill(0.25, offset, offset + QUANTUM);
    samples.fill(-0.5, FRAMES + offset, FRAMES + offset + QUANTUM);
    tags.set([sequence], slot); tags.set([generation], SLOTS + slot); header[0] = sequence;
  }
  function runContinuation(ticket = pendingTicket()) {
    const task = tasks.get(ticket);
    if (!task) throw new Error("No worker continuation was queued");
    tasks.delete(ticket); task();
  }
  return { engine, scope, context, probe, header, tags, samples, posted, legacyProcess, legacyReset, port, init, message,
    queue, wait, store, tasks, receivingPort, sendingPort, runContinuation,
    advance: (milliseconds: number) => { now += milliseconds; }, elapsed: () => now };
}

describe("direct-export audio worker", () => {
  it("warms the configured direct Go chain, reuses its views and resets before real source audio", async () => {
    const fixture = workerFixture();
    const { engine } = fixture;
    engine.process.mockImplementation(() => {
      expect(engine.channel(0).every(Number.isFinite) && engine.channel(1).every(Number.isFinite)).toBe(true);
      expect(engine.channel(0).some(value => value !== 0) && engine.channel(1).some(value => value !== 0)).toBe(true);
      return QUANTUM;
    });
    await fixture.init();
    expect(engine.process).toHaveBeenCalledTimes(256);
    expect(engine.buffer).toHaveBeenCalledTimes(4);
    expect(engine.events).toEqual(["init", "params", "reset", "ready"]);
    for (let index = 0; index < 4; index++) expect(engine.channel(index).every(value => value === 0)).toBe(true);
    expect(fixture.legacyProcess).not.toHaveBeenCalled();
    expect(fixture.legacyReset).not.toHaveBeenCalled();
  });

  it("does not rewind DSP or the read cursor when delayed resets follow a new-generation wake", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 2);
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(1);
    expect(fixture.engine.reset).toHaveBeenCalledTimes(2);
    await fixture.message({ type: "reset", generation: 2 });
    await fixture.message({ type: "reset", generation: 1 });
    expect(fixture.header[1]).toBe(1);
    expect(fixture.engine.reset).toHaveBeenCalledTimes(2);
    fixture.queue(1, 3);
    fixture.probe.pump();
    await fixture.message({ type: "reset", generation: 3 });
    expect(fixture.header[1]).toBe(1);
    expect(fixture.engine.reset).toHaveBeenCalledTimes(3);
    expect(fixture.engine.buffer).toHaveBeenCalledTimes(4);
    expect(fixture.tags[2 * SLOTS]).toBe(1);
    expect(fixture.tags[3 * SLOTS]).toBe(3);
  });

  it("refreshes detached views before input copying and after a processing memory growth", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.engine.memory.grow(1);
    fixture.engine.process.mockImplementationOnce(() => {
      const left = fixture.engine.channel(0).slice(), right = fixture.engine.channel(1).slice();
      fixture.engine.memory.grow(1);
      fixture.engine.channel(2).set(left); fixture.engine.channel(3).set(right);
      return QUANTUM;
    });
    fixture.queue(1, 1);
    fixture.probe.pump();
    expect(fixture.header[5]).toBe(0);
    expect(fixture.header[1]).toBe(1);
    expect(fixture.samples.slice(2 * FRAMES, 2 * FRAMES + QUANTUM).every(value => value === 0.25)).toBe(true);
    expect(fixture.samples.slice(3 * FRAMES, 3 * FRAMES + QUANTUM).every(value => value === -0.5)).toBe(true);
    expect(fixture.engine.buffer).toHaveBeenCalledTimes(12);
  });

  it("refreshes after parameter and reset calls grow memory while preserving published versions", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.scope.aurialisDSPSetParams.mockImplementationOnce(() => { fixture.engine.memory.grow(1); return true; });
    await fixture.message({ type: "params", params: "{}", version: 9 });
    expect(fixture.engine.buffer).toHaveBeenCalledTimes(8);
    fixture.engine.reset.mockImplementationOnce(() => { fixture.engine.memory.grow(1); return 1; });
    fixture.queue(1, 2);
    fixture.probe.pump();
    expect(fixture.engine.buffer).toHaveBeenCalledTimes(12);
    expect(fixture.tags[4 * SLOTS]).toBe(9);
    expect(fixture.samples[2 * FRAMES]).toBe(0.25);
    expect(fixture.samples[3 * FRAMES]).toBe(-0.5);
  });

  it.each(["missing-process", "missing-memory", "null", "misaligned", "overlap", "outside", "fractional"] as const)(
    "rejects a malformed direct ABI (%s) before warmup or ready", async (kind) => {
      const engine = engineFixture();
      if (kind === "missing-process") delete (engine.exports as Partial<typeof engine.exports>).aurialis_live_process;
      else if (kind === "missing-memory") delete (engine.exports as Partial<typeof engine.exports>).mem;
      else engine.buffer.mockImplementation((index) => {
        if (kind === "overlap") return 1024;
        if (index !== 0) return engine.offsets.at(index) ?? 0;
        if (kind === "null") return 0;
        if (kind === "misaligned") return 1025;
        if (kind === "fractional") return 1024.5;
        return engine.memory.buffer.byteLength - 256;
      });
      const fixture = workerFixture(engine);
      await fixture.init();
      expect(fixture.header[5]).toBe(1);
      expect(fixture.posted.some(message => message.type === "ready")).toBe(false);
      expect(fixture.posted.at(-1)?.type).toBe("error");
      expect(engine.process).not.toHaveBeenCalled();
      expect(fixture.receivingPort.close).toHaveBeenCalledOnce();
      expect(fixture.sendingPort.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["process", "reset"] as const)("fails without publishing a block when the direct %s rejects it", async (kind) => {
    const fixture = workerFixture();
    await fixture.init();
    if (kind === "process") fixture.engine.process.mockReturnValueOnce(0);
    else fixture.engine.reset.mockReturnValueOnce(0);
    fixture.samples.fill(0.625, 2 * FRAMES);
    fixture.queue(1, 2);
    fixture.probe.pump();
    expect(fixture.header[5]).toBe(1);
    expect(fixture.header[1]).toBe(0);
    expect(fixture.tags[2 * SLOTS]).toBe(0);
    expect(fixture.samples[2 * FRAMES]).toBe(0.625);
    expect(fixture.posted.at(-1)?.type).toBe("error");
  });

  it("stops queued processing when disposed", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 2);
    await fixture.message({ type: "dispose" });
    fixture.probe.pump();
    expect(fixture.port.close).toHaveBeenCalledOnce();
    expect(fixture.scope.close).toHaveBeenCalledOnce();
    expect(fixture.engine.process).toHaveBeenCalledTimes(256);
    expect(fixture.header[1]).toBe(0);
  });

  it.each(["before-wait", "during-wait"] as const)("consumes input published %s without another port task", async (timing) => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 1);
    fixture.wait.mockImplementationOnce((array, index, expected) => {
      expect(index).toBe(0);
      expect(expected).toBe(1);
      fixture.queue(2, 1);
      // Model the two atomic outcomes: a prior publication fails the predicate;
      // a publication after checking the predicate notifies the parked worker.
      if (timing === "before-wait") {
        expect(Atomics.load(array, index)).not.toBe(expected);
        return "not-equal";
      }
      return "ok";
    });
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(2);
    expect(fixture.tags[2 * SLOTS + 1]).toBe(2);
    expect(fixture.header[7]).toBe(1);
    expect(fixture.tasks.size).toBe(1);
    expect(fixture.wait.mock.calls.every(call => call[3] <= 20)).toBe(true);
  });

  it.each(["before-release", "after-release"] as const)("retains a wake for input published %s", async (timing) => {
    const fixture = workerFixture();
    await fixture.init();
    let published = false;
    fixture.store.mockImplementation((array, index, value) => {
      if (index !== 7 || value !== 0 || published) return Atomics.store(array, index, value);
      published = true;
      if (timing === "before-release") fixture.queue(1, 1);
      const result = Atomics.store(array, index, value);
      if (timing === "after-release") {
        fixture.queue(1, 1);
        // The real producer posts its bootstrap task only on this transition.
        expect(Atomics.compareExchange(array, 7, 0, 1)).toBe(0);
      }
      return result;
    });
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(0);
    expect(fixture.header[7]).toBe(1);
    expect(fixture.tasks.size).toBe(1);
    const stale = fixture.probe.pending();
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(1);
    expect(fixture.tasks.size).toBe(2);
    const current = fixture.probe.pending();
    expect(current).not.toBe(stale);
    fixture.runContinuation(stale);
    expect(fixture.probe.pending()).toBe(current);
    expect(fixture.engine.process).toHaveBeenCalledTimes(257);
  });

  it("ignores a stale queued ticket after a bootstrap and stops scheduling when input pauses", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 1); fixture.probe.pump();
    const stale = fixture.probe.pending();
    fixture.queue(2, 1); fixture.probe.pump();
    const current = fixture.probe.pending();
    expect(current).not.toBe(stale);
    expect(fixture.tasks.size).toBe(2);
    expect(fixture.engine.process).toHaveBeenCalledTimes(258);
    fixture.runContinuation(stale);
    expect(fixture.probe.pending()).toBe(current);
    expect(fixture.tasks.size).toBe(1);
    expect(fixture.engine.process).toHaveBeenCalledTimes(258);
    fixture.runContinuation();
    expect(fixture.header[7]).toBe(0);
    expect(fixture.probe.pending()).toBe(0);
    expect(fixture.tasks.size).toBe(0);
    expect(fixture.engine.process).toHaveBeenCalledTimes(258);
    expect(fixture.context.setTimeout).not.toHaveBeenCalled();
  });

  it("uses a 20 ms cooperative budget so queued settings apply before the next burst", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.engine.process.mockImplementation(() => { fixture.advance(5); return QUANTUM; });
    for (let sequence = 1; sequence <= 8; sequence++) fixture.queue(sequence, 1);
    fixture.probe.pump();
    expect(fixture.elapsed()).toBe(20);
    expect(fixture.header[1]).toBe(4);
    expect(fixture.tasks.size).toBe(1);
    await fixture.message({ type: "params", params: "{}", version: 9 });
    fixture.runContinuation();
    expect(fixture.header[1]).toBe(8);
    expect(fixture.tags[4 * SLOTS + 3]).toBe(1);
    expect(fixture.tags[4 * SLOTS + 4]).toBe(9);
  });

  it("also bounds a fast backlogged burst to 64 blocks", async () => {
    const fixture = workerFixture();
    await fixture.init();
    for (let sequence = 1; sequence <= 70; sequence++) fixture.queue(sequence, 1);
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(64);
    expect(fixture.tasks.size).toBe(1);
    expect(fixture.wait).not.toHaveBeenCalled();
  });

  it("resets a generation changed during a wait before publishing its new input", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 1);
    fixture.wait.mockImplementationOnce(() => { fixture.queue(1, 2); return "ok"; });
    fixture.probe.pump();
    expect(fixture.header[1]).toBe(1);
    expect(fixture.tags[3 * SLOTS]).toBe(2);
    expect(fixture.engine.reset).toHaveBeenCalledTimes(2);
    await fixture.message({ type: "reset", generation: 1 });
    expect(fixture.engine.reset).toHaveBeenCalledTimes(2);
  });

  it("cancels its active continuation and wake lease on dispose", async () => {
    const fixture = workerFixture();
    await fixture.init();
    fixture.queue(1, 1); fixture.probe.pump();
    const stale = fixture.probe.pending();
    expect(fixture.tasks.size).toBe(1);
    await fixture.message({ type: "dispose" });
    expect(fixture.probe.pending()).toBe(0);
    expect(fixture.header[7]).toBe(0);
    expect(fixture.receivingPort.close).toHaveBeenCalledOnce();
    expect(fixture.sendingPort.close).toHaveBeenCalledOnce();
    // Deliver even an already-queued task after close: the stopped/ticket guard
    // must not depend on native queue cancellation to prevent DSP execution.
    fixture.runContinuation(stale);
    fixture.queue(2, 1); fixture.probe.pump();
    expect(fixture.header[1]).toBe(1);
  });
});
