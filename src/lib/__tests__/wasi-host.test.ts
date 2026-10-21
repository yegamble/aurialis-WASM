import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Standard WASI import identifiers: cspell:words fdstat prestat sched oneoff
type Service = (...args: unknown[]) => unknown;
type Imports = {
  args_sizes_get: Service; args_get: Service; environ_sizes_get: Service; environ_get: Service;
  clock_time_get: Service; random_get: Service; fd_fdstat_get: Service; fd_fdstat_set_flags: Service;
  fd_prestat_get: Service; fd_prestat_dir_name: Service; fd_read: Service; fd_close: Service;
  fd_write: Service; proc_exit: Service; sched_yield: Service; poll_oneoff: Service;
};
type Host = { imports: { wasi_snapshot_preview1: Imports }; attach: (memory: unknown) => void; beginRender: () => void };
type Factory = (options: { entropy: unknown; now: unknown }) => Host;

function loadHostFactory(): Factory {
  let factory: Factory | undefined;
  const code = readFileSync("public/worklets/aurialis-wasi-host.js", "utf8").replace(/^export /m, "");
  runInNewContext(`${code}\ninstall(createAurialisWasiHost);`, {
    Uint8Array, DataView, WebAssembly, Date, Error,
    install: (value: Factory) => { factory = value; },
  });
  if (!factory) throw new Error("WASI initialization host was not installed");
  return factory;
}
const createHost = loadHostFactory();

function fixture(now: () => number = () => 1, entropy = Uint8Array.from({ length: 256 }, (_, index) => index)) {
  const host = createHost({ entropy, now });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  host.attach(memory);
  return { host, memory, wasi: host.imports.wasi_snapshot_preview1, entropy, view: () => new DataView(memory.buffer) };
}

describe("restricted WASI initialization host", () => {
  it("requires finite entropy and a clock and allows one valid memory attachment", () => {
    expect(() => createHost({ entropy: new Uint8Array(31), now: () => 1 })).toThrow("entropy");
    expect(() => createHost({ entropy: new Uint8Array(32), now: null })).toThrow("clock");
    const host = createHost({ entropy: new Uint8Array(32), now: () => 1 });
    expect(() => { host.beginRender(); }).toThrow("memory");
    expect(() => { host.attach({}); }).toThrow("invalid memory");
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attach(memory);
    expect(() => { host.attach(memory); }).toThrow("invalid memory");
  });
  it("supplies empty process arguments and environment without filesystem capabilities", () => {
    const f = fixture();
    f.view().setUint32(0, 55, true); f.view().setUint32(4, 66, true);
    expect(f.wasi.args_sizes_get(0, 4)).toBe(0);
    expect([f.view().getUint32(0, true), f.view().getUint32(4, true)]).toEqual([0, 0]);
    f.view().setUint32(0, 55, true); f.view().setUint32(4, 66, true);
    expect(f.wasi.environ_sizes_get(0, 4)).toBe(0);
    expect([f.view().getUint32(0, true), f.view().getUint32(4, true)]).toEqual([0, 0]);
    expect(f.wasi.args_get()).toBe(0); expect(f.wasi.environ_get()).toBe(0);
    for (const call of [f.wasi.fd_fdstat_get, f.wasi.fd_fdstat_set_flags, f.wasi.fd_prestat_get,
      f.wasi.fd_prestat_dir_name, f.wasi.fd_read, f.wasi.fd_close]) expect(call(0, 0, 0, 0)).toBe(8);
  });
  it("consumes only its finite entropy supply and rejects over-budget requests atomically", () => {
    const f = fixture();
    expect(f.wasi.random_get(0, 32)).toBe(0);
    expect(Array.from(new Uint8Array(f.memory.buffer, 0, 32))).toEqual(Array.from(f.entropy.subarray(0, 32)));
    expect(f.wasi.random_get(32, 224)).toBe(0);
    expect(Array.from(new Uint8Array(f.memory.buffer, 0, 256))).toEqual(Array.from(f.entropy));
    new Uint8Array(f.memory.buffer).set([99], 256);
    expect(f.wasi.random_get(256, 1)).toBe(29);
    expect(f.wasi.random_get(256, -1)).toBe(29);
    expect(f.wasi.random_get(256, 0.5)).toBe(29);
    expect(new Uint8Array(f.memory.buffer).at(256)).toBe(99);
    const minimum = fixture(() => 1, new Uint8Array(32).fill(7));
    expect(minimum.wasi.random_get(0, 32)).toBe(0);
    expect(minimum.wasi.random_get(32, 1)).toBe(29);
  });
  it.each([0, -1, Number.NaN, Infinity])("rejects invalid startup monotonic clock %s before Go initialization", (clock) => {
    const f = fixture(() => clock);
    expect(() => f.wasi.clock_time_get(1, 0n, 0)).toThrow("positive initialization clock");
  });
  it("accepts a positive clock that never decreases and rejects backwards movement", () => {
    const clocks = [1.5, 1.5, 1];
    const f = fixture(() => clocks.shift() ?? 1);
    expect(f.wasi.clock_time_get(1, 0n, 0)).toBe(0);
    expect(f.view().getBigUint64(0, true)).toBe(1_500_000n);
    expect(f.wasi.clock_time_get(1, 0n, 0)).toBe(0);
    expect(() => f.wasi.clock_time_get(1, 0n, 0)).toThrow("moved backwards");
    expect(f.wasi.clock_time_get(2, 0n, 0)).toBe(28);
  });
  it("validates every output vector before reporting discarded initialization log bytes", () => {
    const f = fixture();
    const view = f.view();
    view.setUint32(16, 128, true); view.setUint32(20, 10, true);
    view.setUint32(24, 144, true); view.setUint32(28, 20, true);
    expect(f.wasi.fd_write(2, 16, 2, 4)).toBe(0);
    expect(view.getUint32(4, true)).toBe(30);
    for (const [vectors, count] of [[16, -1], [16, 65], [-1, 2], [view.byteLength - 4, 1]]) {
      view.setUint32(4, 99, true);
      expect(f.wasi.fd_write(2, vectors, count, 4)).toBe(28);
      expect(view.getUint32(4, true)).toBe(99);
    }
    view.setUint32(24, view.byteLength - 10, true); view.setUint32(28, 20, true);
    view.setUint32(4, 99, true);
    expect(f.wasi.fd_write(2, 16, 2, 4)).toBe(28);
    expect(view.getUint32(4, true)).toBe(99);
  });
  it("refreshes initialization memory views after WASM memory growth", () => {
    const f = fixture();
    expect(f.wasi.args_sizes_get(0, 4)).toBe(0);
    const oldBuffer = f.memory.buffer;
    f.memory.grow(1);
    expect(oldBuffer.byteLength).toBe(0);
    f.view().setUint32(65536, 17, true); f.view().setUint32(65540, 18, true);
    expect(f.wasi.environ_sizes_get(65536, 65540)).toBe(0);
    expect([f.view().getUint32(65536, true), f.view().getUint32(65540, true)]).toEqual([0, 0]);
  });
  it("rejects every host import after entering render mode", () => {
    const f = fixture();
    f.host.beginRender();
    for (const service of Object.values(f.wasi)) expect(() => service(0, 0n, 0, 0)).toThrow();
    expect(() => f.wasi.poll_oneoff()).toThrow("unsupported blocking wait");
    expect(() => f.wasi.sched_yield()).toThrow("unsupported thread yield");
    expect(() => f.wasi.proc_exit()).toThrow("exited unexpectedly");
  });
});
