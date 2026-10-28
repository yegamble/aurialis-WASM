import type { Page } from "@playwright/test";
type DeviceCapture = { compiledMoves: number; compiledPoints: number; generation: number; seekFrame: number; deviceRate: number; frames: number; missing: number; deviceLeft: number[]; deviceRight: number[]; outputLeft: number[]; outputRight: number[]; versions: number[] };
type CaptureProgress = Pick<DeviceCapture, "generation" | "frames">;
type CapturedWindow = Window & { qaDeviceProgress?: CaptureProgress; snapshotDeviceCapture?: () => Promise<DeviceCapture | null> };
/** Test-only bounded Worker capture of actual dry/wet buffers; UI polling retains no PCM. */
export async function captureDevice(page: Page, deviceRate: number, delayArmMs = 0) {
  await page.addInitScript(({ rate, delay }) => {
    function collect() {
      const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
      let header: Int32Array, tags: Int32Array, samples: Float32Array;
      const left = new Float32Array(262144), right = new Float32Array(262144), wetLeft = new Float32Array(262144), wetRight = new Float32Array(262144), versions = new Int32Array(2048);
      let generation = 0, sourceFrame = 0, deviceRate = 0, seekFrame = 0, count = 0, last = 0, missing = 0, reported = -1, compiledMoves = 0, compiledPoints = 0;
      function drain() {
        if (!header) return;
        const current = Atomics.load(header, 2);
        if (generation !== current) { generation = current; seekFrame = sourceFrame; count = last = missing = 0; reported = -1; }
        if (count < left.length) {
          const written = Atomics.load(header, 1);
          if (written - last > 256) { missing += written - last - 256; last = written - 256; }
          while (last < written && count < left.length) {
            const sequence = last + 1, slot = (sequence - 1) % 256, offset = slot * 128;
            if (Atomics.load(tags, 2 * 256 + slot) !== sequence || Atomics.load(tags, 3 * 256 + slot) !== generation) break;
            for (let index = 0; index < 128; index++) { left[count + index] = samples[offset + index] ?? 0; right[count + index] = samples[32768 + offset + index] ?? 0; wetLeft[count + index] = samples[65536 + offset + index] ?? 0; wetRight[count + index] = samples[98304 + offset + index] ?? 0; }
            if (Atomics.load(tags, 2 * 256 + slot) !== sequence || Atomics.load(tags, 3 * 256 + slot) !== generation) { missing++; break; }
            versions[count / 128] = Atomics.load(tags, 4 * 256 + slot); count += 128; last = sequence;
          }
        }
        if (count - reported >= 4096 || reported < 0 || count === left.length && reported !== count) { reported = count; scope.postMessage({ kind: "progress", generation, frames: count }); }
      }
      scope.onmessage = (event: MessageEvent<{ kind: string; header: SharedArrayBuffer; tags: SharedArrayBuffer; samples: SharedArrayBuffer; rate: number; sourceFrame: number; compiledMoves: number; compiledPoints: number; id: number }>) => {
        const message = event.data;
        if (message.kind === "start") { header = new Int32Array(message.header); tags = new Int32Array(message.tags); samples = new Float32Array(message.samples); deviceRate = message.rate; setInterval(drain, 2); }
        if (message.kind === "arm") { sourceFrame = message.sourceFrame; seekFrame = sourceFrame; }
        if (message.kind === "schedule") { compiledMoves = message.compiledMoves; compiledPoints = message.compiledPoints; }
        if (message.kind === "snapshot") { drain(); const data = [left.slice(0, count), right.slice(0, count), wetLeft.slice(0, count), wetRight.slice(0, count), versions.slice(0, count / 128)]; scope.postMessage({ kind: "snapshot", id: message.id, compiledMoves, compiledPoints, generation, seekFrame, deviceRate, frames: count, missing, data }, data.map((item) => item.buffer)); }
      };
    }
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: rate }); } };
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        const config = options?.processorOptions as { header?: SharedArrayBuffer; tags?: SharedArrayBuffer; samples?: SharedArrayBuffer } | undefined;
        if (!config?.header || !config.tags || !config.samples) return;
        const url = URL.createObjectURL(new Blob(["(" + collect.toString() + ")()"], { type: "text/javascript" })), worker = new Worker(url); URL.revokeObjectURL(url);
        worker.postMessage({ kind: "start", ...config, rate: context.sampleRate });
        const pending = new Map<number, (capture: DeviceCapture) => void>(); let request = 0;
        worker.onmessage = (event: MessageEvent<{ kind: string; id: number; generation: number; frames: number; compiledMoves: number; compiledPoints: number; seekFrame: number; deviceRate: number; missing: number; data: (Float32Array | Int32Array)[] }>) => {
          const { kind, id, data, ...metadata } = event.data;
          (window as CapturedWindow).qaDeviceProgress = { generation: metadata.generation, frames: metadata.frames };
          if (kind === "snapshot") { const [deviceLeft, deviceRight, outputLeft, outputRight, versions] = data.map((item) => Array.from(item)); pending.get(id)?.({ ...metadata, deviceLeft: deviceLeft ?? [], deviceRight: deviceRight ?? [], outputLeft: outputLeft ?? [], outputRight: outputRight ?? [], versions: versions ?? [] }); pending.delete(id); }
        };
        (window as CapturedWindow).snapshotDeviceCapture = () => new Promise<DeviceCapture>((resolve) => { const id = ++request; pending.set(id, resolve); worker.postMessage({ kind: "snapshot", id }); });
        const port = this.port, nativePost = port.postMessage;
        port.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
          if (typeof message === "object" && message !== null && "type" in message && message.type === "arm" && "sourceFrame" in message) worker.postMessage({ kind: "arm", sourceFrame: message.sourceFrame });
          if (typeof message === "object" && message !== null && "type" in message && message.type === "schedule" && "moves" in message && message.moves instanceof Float64Array) { const compiledMoves = message.moves.length / 516; let compiledPoints = 0; for (let index = 0; index < compiledMoves; index++) compiledPoints += message.moves[index * 516 + 1] ?? 0; worker.postMessage({ kind: "schedule", compiledMoves, compiledPoints }); }
          const send = () => { if (transfer === undefined) nativePost.call(port, message); else Reflect.apply(nativePost, port, [message, transfer]); };
          if (delay && typeof message === "object" && message !== null && "type" in message && message.type === "arm") setTimeout(send, delay); else send();
        };
        const cleanup = setInterval(() => { if (context.state === "closed") { clearInterval(cleanup); worker.terminate(); for (const resolve of pending.values()) resolve({ compiledMoves: 0, compiledPoints: 0, generation: 0, seekFrame: 0, deviceRate: 0, frames: 0, missing: 0, deviceLeft: [], deviceRight: [], outputLeft: [], outputRight: [], versions: [] }); pending.clear(); } }, 32);
      }
    };
  }, { rate: deviceRate, delay: delayArmMs });
}
/** Frames the export algorithm's true-peak lookahead delays processed audio at
 * a device rate: the 1.5 ms attack plus 46 frames of detector support
 * (internal/audio/dsp/truepeak.go, pinned by the Go and compiled-reactor
 * contract checks). Captured outputs are the raw processed ring; the worklet
 * plays it this many frames ahead so A lines up with B (V1-10). */
export function exportLatencyFrames(rate: number): number { return Math.round(rate * 0.0015) + 46; }
export function capturedProgress(page: Page) { return page.evaluate(() => (window as CapturedWindow).qaDeviceProgress ?? null); }
export function capturedDevice(page: Page) { return page.evaluate(() => (window as CapturedWindow).snapshotDeviceCapture?.() ?? null); }
