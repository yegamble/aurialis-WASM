/* Fixed Go WASI kernel: no host capabilities or blocking waits while rendering. */
import { createAurialisWasiHost } from "./aurialis-wasi-host.js";
"use strict";
const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
const TAIL_FRAMES = 512; // the engine's drained-tail buffer (aurialis_live_tail_buffer)
const WRITE = 0, READ = 1, GENERATION = 2, APPLIED = 4, ERROR = 5, UNDERRUNS = 6;
const LEGACY_CONTROL_COUNT = 81;
// Go-owned loudness snapshot: momentary, short-term, integrated (LUFS), range
// (LU), true-peak hold, recent true peak (dBTP), recent gain reduction (dB).
const METER_VALUES = 7, NO_READING = -200;
// Deadline watch. The kernel runs inside process(), so the processed ring can
// never run dry from CPU load; overload shows instead as an audio clock that
// falls behind the wall clock, and as kernel time close to the audio rendered.
// The main thread's playbackStats watch (Chromium) is the primary signal; it
// sees real device underruns. Here, each WATCH_SECONDS window after the first
// (warm-up) is bad when the audio clock lost more than WATCH_LAG of it (60 ms
// per 2 s) or the kernel took more than WATCH_LOAD of it; where playbackStats
// is missing, also when a callback or the gap before it overran the output's
// slack (see process()): a short hitch the buffer absorbs is not a miss.
// The lag rule sees load outside the kernel too (other nodes on the render
// thread). Measured 2 s window lag in headless Chromium was 0 ms in every
// window; real devices render in bursts of one output buffer (about 10–40 ms),
// so 60 ms stays above that jitter while a render thread at 1.05× falls 100 ms
// behind per window. Two bad windows in a row fire, so one host stall or a
// burst of buffered callbacks never does, and clock drift (ppm) is far below.
const WATCH_SECONDS = 2, WATCH_LAG = 0.03, WATCH_LOAD = 0.9, WATCH_STRIKES = 2;
const OVERLOAD_MESSAGE = "Playback can't keep up on this device with the current processing. Turn off some processing modules, or close other busy apps or tabs, then press Play.";
const FAULT_MESSAGE = "Live playback lost its processed audio (an internal buffer fault, not a CPU limit). Press Play to restart, and reload the page if it happens again.";
// No AudioWorkletGlobalScope in Chromium has performance.now; Date.now ticks in
// whole milliseconds, which sums without bias over a window.
const wallNow = typeof performance === "object" && performance !== null && typeof performance.now === "function"
  ? () => performance.now() : () => Date.now();
/** The wall clock's step: the gap between its second and third distinct
 * readings, Infinity if it never moves twice within a bounded spin. Browsers
 * that resist fingerprinting tick in 16–100 ms. */
function measureClockStep() {
  let previous = wallNow(), changes = 0;
  for (let spin = 0; spin < 2_000_000; spin++) {
    const now = wallNow();
    if (now === previous) continue;
    if (++changes === 2) return now - previous;
    previous = now;
  }
  return Infinity;
}
class AurialisLiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.header = new Int32Array(config.header);
    if (config.stream !== undefined) {
      if (!(config.stream instanceof SharedArrayBuffer) || config.stream.byteLength !== 24) throw new Error("The source epoch buffer is invalid.");
      this.streamHeader = new Int32Array(config.stream, 0, 2);
      this.streamTime = new Float64Array(config.stream, 8, 2);
      this.streamSequence = 0;
    }
    this.tags = new Int32Array(config.tags);
    this.samples = new Float32Array(config.samples);
    this.delay = config.delayBlocks;
    // Frames the engine delays processed audio (the export algorithm's true-peak
    // lookahead). A is read this far ahead of B so both play the same source frame.
    this.latency = 0;
    this.generation = Atomics.load(this.header, GENERATION);
    this.sequence = 0;
    this.startTime = 0;
    this.sourceFrame = 0;
    this.scheduleAttached = false;
    this.sourceBound = false;
    this.pendingSchedule = null;
    this.pendingDetach = null;
    this.active = false;
    this.original = false;
    this.mix = 0;
    this.volume = 1;
    this.targetVolume = 1;
    // V1-11 static, attenuate-only loudness match (linear, 0 < gain <= 1).
    this.matchProcessed = 1;
    this.matchOriginal = 1;
    this.targetMatchProcessed = 1;
    this.targetMatchOriginal = 1;
    this.endTime = Infinity;
    // V1-13: the lookahead tail the engine drained at the source's end, in
    // processed-stream frames, played in place of the engine's frames while
    // the pass stays finite (see markInputEnd).
    this.tail = [new Float32Array(TAIL_FRAMES), new Float32Array(TAIL_FRAMES)];
    this.tailStart = 0;
    this.tailLength = 0;
    this.tailPending = -1;
    this.ready = false;
    this.controlVersion = 0;
    this.failed = false;
    this.missing = 0;
    // A coarse clock widens the lag bound to two steps.
    this.clockStep = measureClockStep();
    // Fallback missed-deadline rule (browsers without playbackStats): the
    // output's slack in ms, or null where the main thread watches real
    // underruns instead, or the clock is too coarse to time against it.
    const slack = config.watchSlackMs;
    this.slackMs = typeof slack === "number" && Number.isFinite(slack) && slack > 0 && this.clockStep < slack / 2 ? slack : null;
    this.resetWatch();
    this.sum = 0;
    this.peak = 0;
    this.ll = 0;
    this.rr = 0;
    this.lr = 0;
    this.frames = 0;
    this.port.onmessage = (event) => {
      try {
      const message = event.data;
      if (message.type === "reset" || message.type === "arm") {
        if (message.generation !== Atomics.load(this.header, GENERATION)) return;
        if (message.startTime !== undefined && (!Number.isFinite(message.startTime) || message.startTime < 0 || currentTime > message.startTime + 0.5 / sampleRate)) throw new Error("The source start deadline was missed. Retry playback.");
        if (this.active && this.generation === message.generation && message.type !== "arm") return;
        if (this.generation !== message.generation || !this.active) this.resetKernel();
        this.generation = message.generation;
        this.sourceFrame = Number.isSafeInteger(message.sourceFrame) && message.sourceFrame >= 0 ? message.sourceFrame : 0;
        this.startTime = Number.isFinite(message.startTime) && message.startTime >= 0 ? message.startTime : 0;
        if (this.sourceBound && this.kernel.aurialis_schedule_set_looping(Number(message.looping === true)) !== 1) throw new Error("The source loop clock could not be configured.");
        if (this.sourceBound && this.kernel.aurialis_schedule_seek(this.sourceFrame) !== 1) throw new Error("The automation clock could not seek.");
        this.active = message.type !== "arm";
        this.sequence = 0;
        this.endTime = Infinity;
        this.missing = 0;
        this.resetWatch();
        this.sum = this.peak = this.ll = this.rr = this.lr = this.frames = 0;
        if (message.type === "arm") this.port.postMessage({ type: "stream-armed", generation: this.generation });
      } else if (message.type === "hold") {
        this.active = false;
        this.resetWatch();
      } else if (message.type === "rewatch") {
        // The device or context changed: its first callbacks are not this graph's load.
        this.resetWatch();
      } else if (message.type === "bind-source") {
        if (this.active || this.scheduleAttached || !this.numericSchedule || !(message.source instanceof Float64Array) || message.source.length !== 11) throw new Error("The source cannot be bound to this audio graph.");
        this.sourceVector.set(message.source);
        if (this.kernel.aurialis_schedule_bind_source() !== 1) throw new Error("The audio engine rejected the verified source.");
        this.sourceBound = true;
        this.refreshBuffers();
        this.port.postMessage({ type: "automation-ack", token: message.token, revision: 0 });
      } else if (message.type === "schedule") {
        if (!this.sourceBound || !this.numericSchedule || !(message.gate instanceof SharedArrayBuffer) || message.gate.byteLength !== 4 || this.controlAbiVersion !== 2 || !Number.isSafeInteger(message.token) || !Number.isSafeInteger(message.revision) || message.revision < 1 || message.deviceRate !== sampleRate || !Number.isInteger(message.moveCount) || message.moveCount < 0 || message.moveCount > 128 || !(message.moves instanceof Float64Array) || message.moves.length !== message.moveCount * 516 || !(message.controls instanceof Float64Array) || message.controls.length !== 82) {
          this.port.postMessage({ type: "automation-error", token: message.token, message: "The numeric automation packet is invalid." });
        } else this.pendingSchedule = { ...message, gate: new Int32Array(message.gate), index: -1, awaitingCommit: false, commit: false };
      } else if (message.type === "schedule-commit") {
        if (this.pendingSchedule?.token === message.token && this.pendingSchedule.awaitingCommit) this.pendingSchedule.commit = true;
      } else if (message.type === "schedule-cancel") {
        if (this.pendingSchedule?.token === message.token) this.pendingSchedule = null;
      } else if (message.type === "detach") {
        this.pendingSchedule = null;
        if (!(message.gate instanceof SharedArrayBuffer) || message.gate.byteLength !== 4 || !(message.controls instanceof Float64Array) || message.controls.length !== this.controlCount) this.port.postMessage({ type: "automation-error", token: message.token, message: "The static baseline packet is invalid." });
        else this.pendingDetach = { ...message, gate: new Int32Array(message.gate) };
      } else if (message.type === "end" && message.generation === this.generation) {
        if (typeof message.time === "number" && message.time >= 0) this.endTime = message.time;
      } else if (message.type === "original") {
        this.original = message.value;
      } else if (message.type === "volume") {
        this.targetVolume = message.value;
      } else if (message.type === "match") {
        // One fixed monitor gain per side; anything but an attenuation is ignored.
        const valid = value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
        if (valid(message.processed) && valid(message.original)) {
          this.targetMatchProcessed = message.processed;
          this.targetMatchOriginal = message.original;
        }
      }
      } catch (error) { this.fail(error); }
    };
    try {
      this.controlAbiVersion = config.controlAbiVersion === undefined ? 1 : config.controlAbiVersion;
      if (this.controlAbiVersion !== 1 && this.controlAbiVersion !== 2)
        throw new Error("The live audio control ABI is unsupported.");
      this.controlCount = LEGACY_CONTROL_COUNT + (this.controlAbiVersion === 2 ? 1 : 0);
      if (!(config.controls instanceof SharedArrayBuffer) || config.controls.byteLength !== 16 + this.controlCount * 8)
        throw new Error("The live audio settings buffer is invalid.");
      this.controlHeader = new Int32Array(config.controls, 0, 4);
      this.controlValues = new Float64Array(config.controls, 16, this.controlCount);
      const origin = config.clockOriginMs;
      if (!Number.isFinite(origin) || origin <= 0)
        throw new Error("The audio initialization clock is invalid.");
      const host = createAurialisWasiHost({ entropy: config.entropy, now: () => origin + currentTime * 1000 });
      const instance = new WebAssembly.Instance(config.module, host.imports);
      const exports = instance.exports;
      if (!(exports.memory instanceof WebAssembly.Memory)
        || typeof exports._initialize !== "function" || typeof exports.aurialis_init !== "function"
        || typeof exports.aurialis_live_buffer !== "function" || typeof exports.aurialis_control_buffer !== "function"
        || typeof exports.aurialis_live_process !== "function" || typeof exports.aurialis_live_reset !== "function"
        || typeof exports.aurialis_set_controls !== "function"
        || typeof exports.aurialis_control_count !== "function" || typeof exports.aurialis_algorithm_supported !== "function"
        || typeof exports.aurialis_latency_frames !== "function" || typeof exports.aurialis_live_end_input !== "function"
        || typeof exports.aurialis_live_resume_input !== "function" || typeof exports.aurialis_live_tail_buffer !== "function"
        || typeof exports.aurialis_live_tail_frames !== "function"
        || typeof exports.aurialis_meter_buffer !== "function" || typeof exports.aurialis_meter_snapshot !== "function")
        throw new Error("The live audio engine is missing its fixed-buffer interface.");
      host.attach(exports.memory);
      exports._initialize();
      if (exports.aurialis_init(sampleRate) !== 1) throw new Error("The live audio engine rejected the output rate.");
      if (exports.aurialis_control_count(this.controlAbiVersion) !== this.controlCount
        || exports.aurialis_algorithm_supported(1) !== 1)
        throw new Error("The live audio engine and settings capabilities do not match.");
      if (this.controlAbiVersion === 2 && (typeof exports.aurialis_control_buffer_v2 !== "function"
        || typeof exports.aurialis_set_controls_v2 !== "function" || exports.aurialis_algorithm_supported(2) !== 1))
        throw new Error("The live audio engine is missing its versioned settings interface.");
      this.numericSchedule = typeof exports.aurialis_schedule_abi === "function" && exports.aurialis_schedule_abi() === 1
        && ["aurialis_schedule_source_buffer", "aurialis_schedule_bind_source", "aurialis_schedule_begin", "aurialis_schedule_move_buffer", "aurialis_schedule_stage_move", "aurialis_schedule_commit", "aurialis_schedule_revision", "aurialis_schedule_seek", "aurialis_schedule_detach", "aurialis_schedule_set_looping"].every(name => typeof exports[name] === "function");
      this.kernel = exports;
      this.refreshBuffers();
      host.beginRender();
      this.tryReady();
    } catch (error) {
      this.fail(error);
    }
  }
  resetWatch() {
    this.watchWall = null; this.watchFrame = 0; this.watchKernel = 0; this.watchMisses = 0; this.watchWindows = 0; this.watchStrikes = 0; this.watchLastStart = null;
  }
  /** Close a watch window after each processed quantum; true once overload is confirmed. */
  watchDeadline() {
    const now = wallNow(), frame = Math.round(currentTime * sampleRate) + QUANTUM;
    if (this.watchWall === null) { this.watchWall = now; this.watchFrame = frame; this.watchKernel = 0; this.watchMisses = 0; return false; }
    const audioMs = (frame - this.watchFrame) * 1000 / sampleRate;
    if (audioMs < WATCH_SECONDS * 1000) return false;
    const late = now - this.watchWall - audioMs > Math.max(WATCH_LAG * audioMs, 2 * this.clockStep), heavy = this.watchKernel > WATCH_LOAD * audioMs;
    this.watchStrikes = ++this.watchWindows > 1 && (late || heavy || this.watchMisses > 0) ? this.watchStrikes + 1 : 0;
    this.watchWall = now; this.watchFrame = frame; this.watchKernel = 0; this.watchMisses = 0;
    return this.watchStrikes >= WATCH_STRIKES;
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    Atomics.store(this.header, ERROR, 1);
    this.port.postMessage({ type: "error", message: error instanceof Error ? error.message : "Live audio processing failed." });
  }
  refreshBuffers() {
    if (this.kernel.memory.buffer === this.memoryBuffer) return;
    const pointers = [];
    for (let channel = 0; channel < 4; channel++) pointers.push(this.kernel.aurialis_live_buffer(channel));
    pointers.push(this.controlAbiVersion === 2 ? this.kernel.aurialis_control_buffer_v2() : this.kernel.aurialis_control_buffer());
    pointers.push(this.kernel.aurialis_meter_buffer());
    const buffer = this.kernel.memory.buffer;
    const size = index => index === 4 ? this.controlCount * 8 : index === 5 ? METER_VALUES * 8 : QUANTUM * 4;
    for (let index = 0; index < pointers.length; index++) {
      const raw = pointers[index];
      if (!Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)
        throw new Error("The live audio engine returned an invalid buffer address.");
      pointers[index] = raw >>> 0;
      const bytes = size(index);
      const alignment = index >= 4 ? 8 : 4;
      if (pointers[index] === 0 || pointers[index] % alignment !== 0 || pointers[index] + bytes > buffer.byteLength)
        throw new Error("The live audio engine returned an invalid buffer address.");
      for (let previous = 0; previous < index; previous++) {
        const previousBytes = size(previous);
        if (pointers[index] < pointers[previous] + previousBytes && pointers[previous] < pointers[index] + bytes)
          throw new Error("The live audio engine returned overlapping buffers.");
      }
    }
    this.left = new Float32Array(buffer, pointers[0], QUANTUM);
    this.right = new Float32Array(buffer, pointers[1], QUANTUM);
    this.outLeft = new Float32Array(buffer, pointers[2], QUANTUM);
    this.outRight = new Float32Array(buffer, pointers[3], QUANTUM);
    this.controls = new Float64Array(buffer, pointers[4], this.controlCount);
    this.meterValues = new Float64Array(buffer, pointers[5], METER_VALUES);
    if (this.numericSchedule) {
      const sourcePointer = this.kernel.aurialis_schedule_source_buffer() >>> 0;
      const movePointer = this.kernel.aurialis_schedule_move_buffer() >>> 0;
      if (!sourcePointer || sourcePointer % 8 || sourcePointer + 88 > buffer.byteLength || !movePointer || movePointer % 8 || movePointer + 516 * 8 > buffer.byteLength) throw new Error("The schedule buffer address is invalid.");
      this.sourceVector = new Float64Array(buffer, sourcePointer, 11);
      this.moveVector = new Float64Array(buffer, movePointer, 516);
    }
    this.memoryBuffer = buffer;
  }
  applyControls() {
    if (this.scheduleAttached) return true;
    const sequence = Atomics.load(this.controlHeader, 0);
    if (sequence % 2 !== 0) return false;
    const version = Atomics.load(this.controlHeader, 1);
    if (!Number.isInteger(version) || version <= 0) throw new Error("The live audio settings version is invalid.");
    if (version === this.controlVersion) return true;
    this.refreshBuffers();
    for (let index = 0; index < this.controlCount; index++) this.controls[index] = this.controlValues[index];
    // Values AND their applied version belong to this one stable transaction.
    // Never retry/spin on the render thread: retain the prior chain this block.
    if (sequence !== Atomics.load(this.controlHeader, 0)) return false;
    const accepted = this.controlAbiVersion === 2
      ? this.kernel.aurialis_set_controls_v2(this.controlCount) : this.kernel.aurialis_set_controls();
    if (accepted !== 1) throw new Error("The live audio engine rejected these settings.");
    this.refreshBuffers();
    this.readLatency();
    this.controlVersion = version;
    // New settings (a module switched on) change the load: restart the watch
    // with a warm-up window instead of judging the transition.
    this.resetWatch();
    return true;
  }
  readLatency() {
    // The processed ring can only be read ahead within what is already rendered.
    const latency = this.kernel.aurialis_latency_frames();
    if (!Number.isInteger(latency) || latency < 0 || latency > this.delay * QUANTUM)
      throw new Error("The live audio engine reported an unsupported latency.");
    this.latency = latency;
  }
  slotRendered(sequence) {
    const slot = (sequence - 1) % SLOTS;
    return Atomics.load(this.tags, 2 * SLOTS + slot) === sequence && Atomics.load(this.tags, 3 * SLOTS + slot) === this.generation;
  }
  synchronizeStart() {
    if (!this.streamHeader) return;
    const sequence = Atomics.load(this.streamHeader, 0);
    if (!sequence || sequence % 2 || sequence === this.streamSequence) return;
    const generation = Atomics.load(this.streamHeader, 1), frame = this.streamTime[0], endFrame = this.streamTime[1];
    if (sequence !== Atomics.load(this.streamHeader, 0)) return;
    if (generation !== this.generation || generation !== Atomics.load(this.header, GENERATION)) return;
    if (!Number.isSafeInteger(frame) || frame < 0 || !(endFrame === Infinity || Number.isSafeInteger(endFrame) && endFrame >= frame)) throw new Error("The source epoch deadline is invalid.");
    if (!this.active && currentTime * sampleRate > frame + 0.5) throw new Error("The source start deadline was missed. Retry playback.");
    if (this.active && Math.round(this.startTime * sampleRate) !== frame) throw new Error("An active source epoch cannot change.");
    this.startTime = frame / sampleRate; this.endTime = endFrame / sampleRate;
    this.streamSequence = sequence; this.active = true;
  }
  advanceSchedule() {
    const detach = this.pendingDetach;
    if (detach && Atomics.load(detach.gate, 0) !== 1) this.pendingDetach = null;
    if (detach && Atomics.load(detach.gate, 0) === 1) {
      this.pendingDetach = null;
      if (this.scheduleAttached && this.kernel.aurialis_schedule_detach() !== 1) throw new Error("The applied automation could not detach.");
      this.scheduleAttached = false;
      this.refreshBuffers(); this.controls.set(detach.controls);
      const accepted = this.controlAbiVersion === 2 ? this.kernel.aurialis_set_controls_v2(this.controlCount) : this.kernel.aurialis_set_controls();
      if (accepted !== 1) throw new Error("The static baseline could not be restored.");
      this.readLatency();
      this.controlVersion = detach.version;
      this.port.postMessage({ type: "automation-ack", token: detach.token, revision: 0 });
    }
    const pending = this.pendingSchedule;
    if (!pending) return;
    if (Atomics.load(pending.gate, 0) !== 1) { this.pendingSchedule = null; return; }
    try {
      this.refreshBuffers();
      if (pending.index < 0) {
        this.controls.set(pending.controls);
        if (this.kernel.aurialis_schedule_begin(pending.revision, pending.moveCount, pending.deviceRate) !== 1) throw new Error("The audio engine rejected the new schedule. The previous revision remains active.");
        this.refreshBuffers(); pending.index = 0;
      }
      // At most one fixed 256-point move is copied per render quantum.
      if (pending.index < pending.moveCount) {
        const offset = pending.index * 516;
        for (let index = 0; index < 516; index++) this.moveVector[index] = pending.moves[offset + index];
        if (this.kernel.aurialis_schedule_stage_move(pending.index) !== 1) throw new Error("The audio engine rejected an automation move. The previous revision remains active.");
        this.refreshBuffers(); pending.index++;
      }
      if (pending.index === pending.moveCount && !pending.awaitingCommit) {
        pending.awaitingCommit = true;
        this.port.postMessage({ type: "automation-staged", token: pending.token });
      }
      if (pending.commit) {
        pending.commitStarted = true;
        if (this.kernel.aurialis_schedule_commit() !== 1 || this.kernel.aurialis_schedule_revision() !== pending.revision) throw new Error("The audio engine did not acknowledge the complete schedule.");
        this.scheduleAttached = true;
        this.refreshBuffers(); this.readLatency(); this.controlVersion = pending.version;
        this.pendingSchedule = null;
        this.port.postMessage({ type: "automation-ack", token: pending.token, revision: pending.revision });
      }
    } catch (error) {
      this.pendingSchedule = null;
      if (pending.commitStarted) this.fail(error);
      else this.port.postMessage({ type: "automation-error", token: pending.token, message: error instanceof Error ? error.message : "Automation publication failed." });
    }
  }
  resetKernel() {
    if (this.kernel.aurialis_live_reset() !== 1) throw new Error("The live audio engine could not reset.");
    this.inputEnd = undefined;
    this.tailLength = 0; this.tailPending = -1;
    this.refreshBuffers();
  }
  // V1-13: an export drains the limiter's lookahead against silence after the
  // source's last frame (the Go Drain also clears the Nyquist guard). Mark that
  // input frame in the quantum that carries it; the engine then drains the
  // tail an export would, without stopping, and the tail plays in place of the
  // engine's frames while the pass stays finite, so a file that ends loud
  // renders the same final frames live. Input runs the alignment delay ahead
  // of the audible deadline. A later deadline (Repeat turned back on) drops
  // the tail and resumes: the engine kept processing, so the loop continues
  // without a gap or a reset.
  markInputEnd(sequence) {
    const end = this.endTime === Infinity ? Infinity : Math.round(this.endTime * sampleRate) - this.delay * QUANTUM;
    if (this.inputEnd !== undefined && end > this.inputEnd) {
      if (this.kernel.aurialis_live_resume_input() !== 1) throw new Error("The live audio engine could not resume the source.");
      this.inputEnd = undefined; this.tailLength = 0; this.tailPending = -1;
    }
    const offset = end - Math.round(currentTime * sampleRate);
    if (this.inputEnd !== undefined || offset >= QUANTUM) return;
    const at = Math.max(0, offset);
    if (this.kernel.aurialis_live_end_input(at) !== 1) throw new Error("The live audio engine rejected the source end.");
    this.inputEnd = end;
    this.tailPending = (sequence - 1) * QUANTUM + at;
  }
  copyTail() {
    if (this.tailPending < 0) return;
    const frames = this.kernel.aurialis_live_tail_frames();
    if (!Number.isInteger(frames) || frames < 0 || frames > TAIL_FRAMES) throw new Error("The live audio engine returned an invalid tail.");
    for (let channel = 0; channel < 2; channel++) {
      const raw = this.kernel.aurialis_live_tail_buffer(channel);
      if (!Number.isInteger(raw) || raw === 0) throw new Error("The live audio engine returned an invalid buffer address.");
      this.tail[channel].set(new Float32Array(this.kernel.memory.buffer, raw >>> 0, frames));
    }
    this.tailStart = this.tailPending; this.tailLength = frames; this.tailPending = -1;
  }
  tryReady() {
    if (this.ready || !this.applyControls()) return;
    for (let index = 0; index < QUANTUM; index++) {
      this.left[index] = 0.05 * Math.sin(2 * Math.PI * 1000 * index / sampleRate);
      this.right[index] = 0.04 * Math.sin(2 * Math.PI * 1000 * index / sampleRate + 0.3);
    }
    for (let block = 0; block < 256; block++) {
      if (this.kernel.aurialis_live_process() !== QUANTUM) throw new Error("The live audio engine could not warm up.");
      this.refreshBuffers();
    }
    this.resetKernel();
    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }
  /** Fallback missed deadlines: a whole callback, or the gap since the previous
   * one, overrunning the quantum by more than the output's slack (plus one
   * clock step). A shorter overrun is absorbed by the output buffer. */
  process(inputs, outputs) {
    if (this.slackMs === null) return this.renderQuantum(inputs, outputs);
    const start = wallNow();
    const result = this.renderQuantum(inputs, outputs);
    if (this.active && !this.failed && this.watchWall !== null) {
      const quantumMs = 1000 * QUANTUM / sampleRate, bound = this.slackMs + this.clockStep;
      if (wallNow() - start - quantumMs > bound || (this.watchLastStart !== null && start - this.watchLastStart - quantumMs > bound)) this.watchMisses++;
      this.watchLastStart = start;
    } else this.watchLastStart = null;
    return result;
  }
  renderQuantum(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0], outR = output[1];
    if (!this.ready && !this.failed) {
      try { this.tryReady(); } catch (error) { this.fail(error); }
    }
    if (this.ready && !this.failed) {
      try { this.synchronizeStart(); this.advanceSchedule(); } catch (error) { this.fail(error); }
    }
    // Connecting a graph is not a playback deadline: the controller can still
    // be allocating/copying its source. Only its explicit reset starts a stream.
    if (!this.ready || !this.active || currentTime + 0.5 / sampleRate < this.startTime || outL.length !== QUANTUM || this.failed || Atomics.load(this.header, ERROR)) {
      outL.fill(0); outR.fill(0); return true;
    }
    const input = inputs[0], inL = input?.[0], inR = input?.[1] || inL;
    const sequence = ++this.sequence, slot = (sequence - 1) % SLOTS, offset = slot * QUANTUM;
    if (this.generation !== Atomics.load(this.header, GENERATION)) {
      outL.fill(0); outR.fill(0); return true;
    }
    if (sequence - Atomics.load(this.header, READ) >= SLOTS) {
      // A seek resets READ with a new generation; only a ring fault in this
      // generation is reported.
      if (this.generation !== Atomics.load(this.header, GENERATION)) { outL.fill(0); outR.fill(0); return true; }
      this.failed = true;
      this.port.postMessage({ type: "error", message: FAULT_MESSAGE });
      outL.fill(0); outR.fill(0); return true;
    }
    try {
      this.applyControls();
      this.refreshBuffers();
      for (let i = 0; i < QUANTUM; i++) {
        const l = inL ? inL[i] : 0, r = inR ? inR[i] : 0;
        this.samples[offset + i] = this.left[i] = l;
        this.samples[FRAMES + offset + i] = this.right[i] = r;
      }
      Atomics.store(this.tags, slot, sequence);
      Atomics.store(this.tags, SLOTS + slot, this.generation);
      Atomics.store(this.header, WRITE, sequence);
      this.markInputEnd(sequence);
      const kernelStart = wallNow();
      if (this.kernel.aurialis_live_process() !== QUANTUM)
        throw new Error("The live audio engine rejected an audio block.");
      const kernelMs = wallNow() - kernelStart;
      this.watchKernel += kernelMs;
      this.refreshBuffers();
      if (this.generation !== Atomics.load(this.header, GENERATION)) {
        outL.fill(0); outR.fill(0); return true;
      }
      this.copyTail();
      for (let i = 0; i < QUANTUM; i++) {
        this.samples[2 * FRAMES + offset + i] = this.outLeft[i];
        this.samples[3 * FRAMES + offset + i] = this.outRight[i];
      }
      Atomics.store(this.tags, 4 * SLOTS + slot, this.controlVersion);
      Atomics.store(this.tags, 3 * SLOTS + slot, this.generation);
      Atomics.store(this.tags, 2 * SLOTS + slot, sequence);
      Atomics.store(this.header, READ, sequence);
    } catch (error) {
      this.fail(error);
      outL.fill(0); outR.fill(0); return true;
    }
    if (this.watchDeadline()) {
      this.failed = true;
      this.port.postMessage({ type: "error", message: OVERLOAD_MESSAGE });
      outL.fill(0); outR.fill(0); return true;
    }
    // B (dry) for this quantum is stream frame (expected - 1) * QUANTUM onward.
    // The engine renders A for that source frame `latency` frames later, so A
    // is read that far ahead in the processed ring: A and B, the playhead and
    // the meters then share one clock and switching is never offset.
    const expected = sequence - this.delay;
    const outputSlot = (expected - 1 + SLOTS) % SLOTS, outputOffset = outputSlot * QUANTUM;
    const wetStart = (expected - 1) * QUANTUM + this.latency;
    const wetFirst = Math.floor(wetStart / QUANTUM) + 1, wetLast = Math.floor((wetStart + QUANTUM - 1) / QUANTUM) + 1;
    const available = expected > 0 && this.slotRendered(wetFirst) && this.slotRendered(wetLast);
    if (expected > 0 && !available) {
      Atomics.add(this.header, UNDERRUNS, 1);
      if (++this.missing > Math.ceil(sampleRate * 0.2 / QUANTUM)) {
        this.failed = true;
        // Processed audio is missing although the kernel ran: a tag or generation
        // fault, not CPU load (the deadline watch reports that).
        this.port.postMessage({ type: "error", message: FAULT_MESSAGE });
      }
    } else this.missing = 0;
    if (available) Atomics.store(this.header, APPLIED, Atomics.load(this.tags, 4 * SLOTS + (wetFirst - 1) % SLOTS));
    const targetMix = this.original ? 1 : 0;
    const step = 1 / (sampleRate * 0.008);
    const volumeStep = 1 / (sampleRate * 0.01);
    const blockFrame = Math.round(currentTime * sampleRate), endFrame = Math.round(this.endTime * sampleRate);
    for (let i = 0; i < QUANTUM; i++) {
      this.mix += Math.max(-step, Math.min(step, targetMix - this.mix));
      this.volume += Math.max(-volumeStep, Math.min(volumeStep, this.targetVolume - this.volume));
      // A changed match ramps once over 10 ms like volume, then stays fixed.
      this.matchProcessed += Math.max(-volumeStep, Math.min(volumeStep, this.targetMatchProcessed - this.matchProcessed));
      this.matchOriginal += Math.max(-volumeStep, Math.min(volumeStep, this.targetMatchOriginal - this.matchOriginal));
      const dryL = expected > 0 ? this.samples[outputOffset + i] : 0;
      const dryR = expected > 0 ? this.samples[FRAMES + outputOffset + i] : 0;
      const wetIndex = (wetStart + i) % FRAMES, tailIndex = wetStart + i - this.tailStart;
      const inTail = tailIndex >= 0 && tailIndex < this.tailLength;
      const wetL = available ? (inTail ? this.tail[0][tailIndex] : this.samples[2 * FRAMES + wetIndex]) : 0;
      const wetR = available ? (inTail ? this.tail[1][tailIndex] : this.samples[3 * FRAMES + wetIndex]) : 0;
      const audible = blockFrame + i < endFrame;
      const wet = 1 - this.mix, dry = this.mix;
      // Meters read the selected A or B at monitor volume, before the static
      // loudness match, so the match never shows up as a level change.
      const l = audible ? (wetL * wet + dryL * dry) * this.volume : 0;
      const r = audible ? (wetR * wet + dryR * dry) * this.volume : 0;
      outL[i] = audible ? (wetL * wet * this.matchProcessed + dryL * dry * this.matchOriginal) * this.volume : 0;
      outR[i] = audible ? (wetR * wet * this.matchProcessed + dryR * dry * this.matchOriginal) * this.volume : 0;
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      this.sum += l * l + r * r;
      this.ll += l * l; this.rr += r * r; this.lr += l * r;
    }
    this.frames += QUANTUM;
    if (this.frames >= sampleRate * 0.05) {
      const rms = Math.sqrt(this.sum / (this.frames * 2));
      const db = value => value > 1e-12 ? 20 * Math.log10(value) : -120;
      const denominator = Math.sqrt(this.ll * this.rr);
      let loudness;
      try {
        if (this.kernel.aurialis_meter_snapshot() !== METER_VALUES) throw new Error("The live loudness meter is unavailable.");
        this.refreshBuffers();
        const v = this.meterValues, reading = value => value > NO_READING ? value : null, peak = value => Math.max(-120, value);
        loudness = { momentaryLufs: reading(v[0]), shortTermLufs: reading(v[1]), integratedLufs: reading(v[2]),
          loudnessRangeLu: reading(v[3]), truePeakDbtp: peak(v[4]), recentTruePeakDbtp: peak(v[5]), gainReductionDb: Math.max(0, v[6]) };
      } catch (error) { this.fail(error); return true; }
      this.port.postMessage({ type: "meter", generation: this.generation, time: currentTime + QUANTUM / sampleRate,
        peakDbfs: db(this.peak), rmsDbfs: db(rms), crestDb: rms > 1e-12 ? db(this.peak / rms) : 0,
        correlation: denominator > 1e-12 ? Math.max(-1, Math.min(1, this.lr / denominator)) : 1, ...loudness });
      this.sum = this.peak = this.ll = this.rr = this.lr = this.frames = 0;
    }
    return true;
  }
}
registerProcessor("aurialis-live", AurialisLiveProcessor);
