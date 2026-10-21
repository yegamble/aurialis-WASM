/* A finite initialization host. The mastering kernel needs no host calls while rendering. */
/* cspell:words fdstat prestat sched oneoff */
export function createAurialisWasiHost({ entropy, now }) {
  if (!(entropy instanceof Uint8Array) || entropy.length < 32 || typeof now !== "function")
    throw new Error("The audio engine requires initialization entropy and a clock.");
  let memory, cachedBuffer, data;
  let used = 0;
  let rendering = false;
  let lastClock = 0;
  function view() {
    if (!memory) throw new Error("The audio engine memory is unavailable.");
    if (cachedBuffer !== memory.buffer) {
      cachedBuffer = memory.buffer;
      data = new DataView(cachedBuffer);
    }
    return data;
  }
  function initializationOnly() {
    if (rendering) throw new Error("The audio engine requested a host service during rendering.");
  }
  function emptySizes(count, bytes) {
    initializationOnly();
    const target = view();
    target.setUint32(count, 0, true);
    target.setUint32(bytes, 0, true);
    return 0;
  }
  function deniedDescriptor() { initializationOnly(); return 8; }
  const wasi = {
    args_sizes_get: emptySizes,
    args_get() { initializationOnly(); return 0; },
    environ_sizes_get: emptySizes,
    environ_get() { initializationOnly(); return 0; },
    clock_time_get(id, _precision, output) {
      initializationOnly();
      if (id !== 0 && id !== 1) return 28;
      const milliseconds = id === 0 ? Date.now() : now();
      if (!Number.isFinite(milliseconds) || milliseconds <= 0)
        throw new Error("The audio engine requires a positive initialization clock.");
      if (id === 1) {
        if (milliseconds < lastClock) throw new Error("The audio engine clock moved backwards.");
        lastClock = milliseconds;
      }
      const nanoseconds = Math.floor(milliseconds * 1000000);
      const target = view();
      target.setUint32(output, nanoseconds >>> 0, true);
      target.setUint32(output + 4, Math.floor(nanoseconds / 4294967296) >>> 0, true);
      return 0;
    },
    random_get(output, length) {
      initializationOnly();
      if (!Number.isInteger(length) || length < 0 || used + length > entropy.length) return 29;
      const target = new Uint8Array(memory.buffer, output, length);
      for (let index = 0; index < length; index++) target[index] = entropy[used + index];
      used += length;
      return 0;
    },
    fd_fdstat_get: deniedDescriptor,
    fd_fdstat_set_flags: deniedDescriptor,
    fd_prestat_get: deniedDescriptor,
    fd_prestat_dir_name: deniedDescriptor,
    fd_read: deniedDescriptor,
    fd_close: deniedDescriptor,
    fd_write(_descriptor, vectors, count, written) {
      initializationOnly();
      const target = view();
      if (!Number.isInteger(count) || count < 0 || count > 64
        || !Number.isInteger(vectors) || vectors < 0 || vectors + count * 8 > target.byteLength) return 28;
      let bytes = 0;
      for (let index = 0; index < count; index++) {
        const pointer = target.getUint32(vectors + index * 8, true);
        const length = target.getUint32(vectors + index * 8 + 4, true);
        if (pointer + length > target.byteLength) return 28;
        bytes += length;
      }
      target.setUint32(written, bytes, true);
      return 0;
    },
    proc_exit() { throw new Error("The audio engine exited unexpectedly."); },
    sched_yield() { throw new Error("The audio engine requested an unsupported thread yield."); },
    poll_oneoff() { throw new Error("The audio engine requested an unsupported blocking wait."); },
  };
  return {
    imports: { wasi_snapshot_preview1: wasi },
    attach(value) {
      if (memory || !(value instanceof WebAssembly.Memory))
        throw new Error("The audio engine returned invalid memory.");
      memory = value;
    },
    beginRender() { view(); rendering = true; },
  };
}
