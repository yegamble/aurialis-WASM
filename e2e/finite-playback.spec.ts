import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { exportScript } from "../src/lib/engine-params";
import { capturedDevice, captureDeepDevice, exportLatencyFrames } from "./deep-capture";
import { fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";
const execute = promisify(execFile);
type SpeakerCapture = { left: number[]; right: number[]; chunks: { time: number; contextTime: number; begin: number }[]; starts: { when: number; offset: number; looping: boolean }[] };
type SpeakerWindow = Window & { finiteSpeaker?: SpeakerCapture };
function boundarySource(rate: number, frames: number) {
  const wav = Buffer.alloc(44 + frames * 8); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write("data", 36); wav.writeUInt32LE(frames * 8, 40);
  for (let frame = 0; frame < frames; frame++) { const value = frame < 16 ? .8 : frame >= frames - 16 ? -.8 : .12 * Math.cos(frame * .13); wav.writeFloatLE(value, 44 + frame * 8); wav.writeFloatLE(value * .7, 48 + frame * 8); } return wav;
}
async function project(page: Page) { const track = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]); if (!track) throw new Error("Missing canonical project"); return track; }
async function observeFiniteSpeaker(page: Page) {
  // A separate test-only processor observes the actual merger feeding the
  // destination. Main-thread callback delays cannot discard or repeat PCM.
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options); const load = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = async (url, moduleOptions) => { await load(url, moduleOptions); if (String(url).includes("aurialis-live-worklet.js")) await load("/__qa/actual-output-tap.js", moduleOptions); };
      }
    };
    const probe: SpeakerCapture = { left: [], right: [], chunks: [], starts: [] }; (window as SpeakerWindow).finiteSpeaker = probe;
    const header = new Int32Array(new SharedArrayBuffer(8)), samples = new Float32Array(new SharedArrayBuffer(2 * 262144 * 4)), times = new Float64Array(new SharedArrayBuffer(2048 * 8));
    (window as SpeakerWindow & { snapshotFiniteSpeaker?: () => SpeakerCapture }).snapshotFiniteSpeaker = () => {
      const count = Atomics.load(header, 1); return { starts: probe.starts, left: Array.from(samples.slice(0, count)), right: Array.from(samples.slice(262144, 262144 + count)), chunks: Array.from(times.slice(0, count / 128), (time, index) => ({ time, contextTime: time, begin: index * 128 })) };
    };
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) { if (this.context instanceof AudioContext) { Atomics.add(header, 0, 1); probe.starts.push({ when, offset, looping: this.loop }); } if (duration === undefined) nativeStart.call(this, when, offset); else nativeStart.call(this, when, offset, duration); };
    const nativeConnect = AudioNode.prototype.connect, observed = new WeakSet<AudioNode>();
    function connect(this: AudioNode, destination: AudioNode, output?: number, input?: number): AudioNode;
    function connect(this: AudioNode, destination: AudioParam, output?: number): void;
    function connect(this: AudioNode, destination: AudioNode | AudioParam, ...ports: (number | undefined)[]): AudioNode | void {
      const result: unknown = Reflect.apply(nativeConnect, this, [destination, ...ports]);
      if (destination instanceof AudioDestinationNode && this.context instanceof AudioContext && !observed.has(this)) {
        observed.add(this); const context = this.context, tap = new AudioWorkletNode(context, "finite-speaker-capture", { channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2], processorOptions: { header: header.buffer, samples: samples.buffer, times: times.buffer } });
        const silent = context.createGain(); silent.gain.value = 0;
        Reflect.apply(nativeConnect, this, [tap]); Reflect.apply(nativeConnect, tap, [silent]); Reflect.apply(nativeConnect, silent, [destination]);
      }
      return result instanceof AudioNode ? result : undefined;
    }
    AudioNode.prototype.connect = connect;
  });
}
async function speakerSnapshot(page: Page) { return page.evaluate(() => (window as SpeakerWindow & { snapshotFiniteSpeaker?: () => SpeakerCapture }).snapshotFiniteSpeaker?.()); }

test("Reset modules never releases delayed unlimited frames after heavy gain reduction", async ({ page }, info) => {
  await observeFiniteSpeaker(page);
  const wav = fixture(220, 6);
  // Source peaks at -3.1 dBFS; +12 dB input needs over 10 dB of limiting.
  for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(Math.round(wav.readInt16LE(offset) * 3.5), offset);
  await uploadProject(page, "reset-under-limiting.wav", 6, wav);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("12");
  await page.getByRole("checkbox", { name: "Enable limiter", exact: true }).check();
  await page.getByRole("slider", { name: "Limiter ceiling", exact: true }).fill("-1");
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  const reset = page.getByRole("button", { name: "Reset modules", exact: true });
  await reset.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await speakerSnapshot(page))?.left.length ?? 0).toBeGreaterThan(48000);
  const reduction = page.getByRole("region", { name: "Live loudness of the processed output", exact: true }).locator("div").filter({ has: page.getByText("Gain reduction", { exact: true }) }).locator("strong");
  await expect.poll(async () => Number(await reduction.innerText())).toBeGreaterThan(3);
  const before = await speakerSnapshot(page);
  if (!before) throw new Error("Missing speaker capture before Reset modules");
  await reset.click();
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("0");
  await expect(page.getByRole("checkbox", { name: "Enable limiter", exact: true })).not.toBeChecked();
  await expect.poll(async () => (await speakerSnapshot(page))?.left.length ?? 0).toBeGreaterThan(before.left.length + 4800);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const after = await speakerSnapshot(page);
  if (!after) throw new Error("Missing speaker capture after Reset modules");
  const peak = [...after.left, ...after.right].reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
  const evidence = { sourcePeakDbfs: -3.1, inputGainDb: 12, ceilingDbtp: -1, beforeFrames: before.left.length, afterFrames: after.left.length, peakDbfs: 20 * Math.log10(peak) };
  await info.attach("reset-speaker-peak", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(peak, JSON.stringify(evidence)).toBeLessThanOrEqual(10 ** (-1 / 20));
  const tail = after.left.slice(-1024);
  expect(Math.max(...tail.map(Math.abs)), "Reset must return to audible source at -3.1 dBFS").toBeCloseTo(0.7, 2);
});

type LateRepeatWindow = SpeakerWindow & { lateRepeat?: { elapsed: number; duration: number; disabledAt: number } };
test("Repeat restored in the final 80 ms of a finite looping pass keeps the speaker stream continuous", async ({ page }, info) => {
  await captureDeepDevice(page, 48000);
  await observeFiniteSpeaker(page);
  await page.addInitScript(() => {
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      if (duration === undefined) nativeStart.call(this, when, offset); else nativeStart.call(this, when, offset, duration);
      if (!(this.context instanceof AudioContext) || (window as SpeakerWindow).finiteSpeaker?.starts.length !== 1 || !this.buffer) return;
      const context = this.context, length = this.buffer.duration - offset;
      let disabledAt = 0;
      const timer = setInterval(() => {
        const elapsed = context.currentTime - when;
        const repeat = document.querySelector<HTMLButtonElement>('button[aria-label="Repeat track"]');
        if (!disabledAt && elapsed >= 0.25 && repeat?.getAttribute("aria-pressed") === "true") {
          disabledAt = elapsed;
          repeat.click();
        }
        if (elapsed < length - 0.06) return;
        clearInterval(timer);
        (window as LateRepeatWindow).lateRepeat = { elapsed, duration: length, disabledAt };
        repeat?.click();
      }, 1);
    };
  });
  await uploadProject(page, "late-repeat.wav", 2, fixture(220, 2));
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as LateRepeatWindow).lateRepeat)).toBeTruthy();
  const timing = await page.evaluate(() => (window as LateRepeatWindow).lateRepeat);
  if (!timing) throw new Error("Missing Repeat activation time");
  expect(timing.disabledAt).toBeGreaterThan(0);
  expect(timing.disabledAt).toBeLessThan(timing.elapsed);
  expect(timing.duration - timing.elapsed).toBeGreaterThan(0);
  expect(timing.duration - timing.elapsed).toBeLessThanOrEqual(0.08);
  await expect(page.getByRole("button", { name: "Repeat track", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await speakerSnapshot(page))?.left.length ?? 0).toBeGreaterThan(48000 * 2.5);
  await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const speaker = await speakerSnapshot(page);
  if (!speaker?.starts[0]) throw new Error("Missing Repeat speaker capture");
  expect(speaker.starts, "late Repeat must resume the current source epoch").toHaveLength(1);
  expect(speaker.starts[0].looping).toBe(true);
  const start = speaker.starts[0].when;
  const boundary = speaker.chunks.find((chunk) => chunk.time >= start + 2)?.begin;
  if (boundary === undefined) throw new Error("Capture did not reach the source boundary");
  let minimumRms = Infinity;
  for (let frame = boundary - 2048; frame < boundary + 4096; frame += 512) {
    const samples = speaker.left.slice(frame, frame + 512);
    expect(samples).toHaveLength(512);
    minimumRms = Math.min(minimumRms, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length));
  }
  await info.attach("late-repeat-speaker", { body: JSON.stringify({ timing, minimumRms, starts: speaker.starts }, null, 2), contentType: "application/json" });
  expect(minimumRms, "speaker output must remain audible across the original finite end").toBeGreaterThan(0.1);
});

function verifySpeakerClock(speaker: SpeakerCapture, rate: number, first: number) {
  for (let index = 1; index < speaker.chunks.length; index++) expect(((speaker.chunks[index]?.time ?? 0) - (speaker.chunks[index - 1]?.time ?? 0)) * rate).toBeCloseTo(128, 5);
  const start = speaker.starts.at(-1); if (!start) throw new Error("Missing native source epoch");
  expect(Math.round((speaker.chunks[0]?.time ?? 0) * rate) + first).toBe(Math.round(start.when * rate) + Math.ceil(rate * .08 / 128) * 128);
}
async function finiteDry(page: Page, track: Track, deviceRate: number, seek: number, count: number, looping = false) {
  return page.evaluate(async ({ key, rate, frame, count, looping }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const blob = await new Promise<Blob>((resolve, reject) => { const request = db.transaction("audio").objectStore("audio").get(key); request.onsuccess = () => resolve(request.result as Blob); request.onerror = () => reject(request.error); }); db.close();
    const view = new DataView(await blob.arrayBuffer()), sourceRate = view.getUint32(24, true), frames = view.getUint32(40, true) / 8;
    const context = new OfflineAudioContext(2, count, rate), buffer = context.createBuffer(2, frames, sourceRate);
    for (let index = 0; index < frames; index++) { buffer.getChannelData(0)[index] = view.getFloat32(44 + index * 8, true); buffer.getChannelData(1)[index] = view.getFloat32(48 + index * 8, true); }
    const node = context.createBufferSource(); node.buffer = buffer; node.loop = looping; node.connect(context.destination); node.start(0, frame / sourceRate);
    const result = await context.startRendering(); return { left: Array.from(result.getChannelData(0)), right: Array.from(result.getChannelData(1)) };
  }, { key: track.sourceAudioId ?? track.id, rate: deviceRate, frame: seek, count, looping });
}
for (const [sourceRate, frames, deviceRate] of [[8001, 129, 44100], [8000, 129, 48000], [44100, 129, 96000], [8001, 4001, 44100]] as const) {
  test(`finite zero-exterior source, complete audible tail and native wet PCM at ${sourceRate}/${frames}→${deviceRate}`, async ({ page }, info) => {
    test.setTimeout(90000); await captureDeepDevice(page, deviceRate, 35); await observeFiniteSpeaker(page);
    await page.goto("/"); await page.getByLabel("Import audio file").setInputFiles({ name: "finite-boundary.wav", mimeType: "audio/wav", buffer: boundarySource(sourceRate, frames) });
    await expect(page).toHaveURL(/\/master\/track-/u); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: "deep", exact: true }).click(); await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
    await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => !!(await project(page)).deepMastering?.applied).toBe(true);
    const track = await project(page), script = track.deepMastering?.applied; if (!script) throw new Error("Missing acknowledged applied script");
    const evidence = [];
    for (const seek of [0, Math.floor(frames / 3)]) {
      if (seek > 0) {
        const waveform = page.getByRole("slider", { name: "Track playback position", exact: true }), box = await waveform.boundingBox(); if (!box) throw new Error("Missing waveform");
        await waveform.click({ position: { x: box.width / 3, y: box.height / 2 } });
      }
      const priorStarts = await page.evaluate(() => (window as SpeakerWindow).finiteSpeaker?.starts.length ?? 0);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as SpeakerWindow).finiteSpeaker?.starts.length ?? 0)).toBe(priorStarts + 1);
      await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "false");
      const capture = await capturedDevice(page); if (!capture) throw new Error("Missing finite device capture"); expect(capture.missing).toBe(0); expect(capture.seekFrame === 0).toBe(seek === 0);
      const validFrames = Math.ceil((frames - capture.seekFrame) * deviceRate / sourceRate); expect(capture.frames).toBeGreaterThan(validFrames);
      const expected = await finiteDry(page, track, deviceRate, capture.seekFrame, capture.frames);
      let dryError = 0; for (let index = 0; index < capture.frames; index++) dryError = Math.max(dryError, Math.abs((expected.left[index] ?? 0) - (capture.deviceLeft[index] ?? 0)), Math.abs((expected.right[index] ?? 0) - (capture.deviceRight[index] ?? 0)));
      expect(dryError, "Actual finite SRC must match independent loop=false zero exterior, including its final device frames").toBeLessThan(1e-6);
      const inputPath = info.outputPath("finite-input-" + String(seek) + ".json"), outputPath = info.outputPath("finite-native-" + String(seek) + ".json");
      await writeFile(inputPath, JSON.stringify({ sourceRate, frames, deviceRate, seek: capture.seekFrame, looping: false, capturedFrames: capture.frames, script: exportScript(script), deviceLeft: capture.deviceLeft, deviceRight: capture.deviceRight, endFrame: validFrames }));
      const native = await execute("go", ["test", "./wasm/dsp", "-run", "^TestCapturedDeviceNativeOracle$", "-count=1"], { cwd: process.cwd(), env: { ...process.env, AURIALIS_CAPTURED_INPUT_FIXTURE: inputPath, AURIALIS_CAPTURED_OUTPUT_FIXTURE: outputPath }, timeout: 60000 }); expect(native.stdout).toContain("ok");
      // The processed ring is the engine's output; at the source's end the
      // speaker plays the export's drained lookahead tail instead (V1-13).
      const wet = JSON.parse(await readFile(outputPath, "utf8")) as { outputLeft: number[]; outputRight: number[]; speakerLeft: number[]; speakerRight: number[] };
      let wetError = 0; for (let index = 0; index < capture.frames; index++) wetError = Math.max(wetError, Math.abs((wet.outputLeft[index] ?? 0) - (capture.outputLeft[index] ?? 0)), Math.abs((wet.outputRight[index] ?? 0) - (capture.outputRight[index] ?? 0))); expect(wetError).toBeLessThan(1e-6);
      const speaker = await speakerSnapshot(page); if (!speaker) throw new Error("Missing speaker capture"); expect(speaker.starts.at(-1)?.looping).toBe(false);
      const first = speaker.left.findIndex((value) => value !== 0); expect(first).toBeGreaterThanOrEqual(0); verifySpeakerClock(speaker, deviceRate, first); expect(speaker.left.length - first).toBeGreaterThanOrEqual(validFrames);
      const latency = exportLatencyFrames(deviceRate); expect(capture.frames).toBeGreaterThanOrEqual(latency + validFrames);
      let audibleError = 0; for (let index = 0; index < validFrames; index++) audibleError = Math.max(audibleError, Math.abs((speaker.left[first + index] ?? 0) - (wet.speakerLeft[latency + index] ?? 0)), Math.abs((speaker.right[first + index] ?? 0) - (wet.speakerRight[latency + index] ?? 0)));
      await writeFile(info.outputPath("speaker-diagnostic-" + String(seek) + ".json"), JSON.stringify({ validFrames, first, speaker, expectedLeft: wet.speakerLeft.slice(latency, latency + validFrames), expectedRight: wet.speakerRight.slice(latency, latency + validFrames), latency, audibleError }));
      expect(audibleError, "All valid output, including the final buffered 80 ms, must reach the actual speaker feed").toBeLessThan(1e-6);
      expect(speaker.left.slice(first + validFrames).every((value) => value === 0)).toBe(true); expect(speaker.right.slice(first + validFrames).every((value) => value === 0)).toBe(true);
      evidence.push({ sourceRate, frames, deviceRate, seekFrame: capture.seekFrame, validFrames, capturedFrames: capture.frames, dryMaximumError: dryError, nativeWetMaximumError: wetError, audibleMaximumError: audibleError, audibleTailFrames: Math.min(validFrames, Math.ceil(.08 * deviceRate)), speakerFrames: speaker.left.length, silentFramesAfterEnd: speaker.left.length - first - validFrames });
    }
    await writeFile(info.outputPath("finite-pcm-evidence.json"), JSON.stringify(evidence, null, 2));
  });
}

type RepeatProbe = { stream: SharedArrayBuffer; arms: number; held: boolean; release?: () => void; finiteDeadline?: number; restoredDeadline?: number };
type RepeatWindow = SpeakerWindow & { repeatProbe?: RepeatProbe };
test("129-frame Repeat latest intent cancels a deferred clean epoch and removes a periodic deadline", async ({ page }, info) => {
  await captureDeepDevice(page, 44100); await observeFiniteSpeaker(page);
  await page.addInitScript(() => {
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options); const config = options?.processorOptions as { stream?: SharedArrayBuffer } | undefined; if (!config?.stream) return;
        const probe: RepeatProbe = { stream: config.stream, arms: 0, held: false }; (window as RepeatWindow).repeatProbe = probe;
        const port = this.port, nativePost = port.postMessage;
        port.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
          const send = () => { if (transfer === undefined) nativePost.call(port, message); else Reflect.apply(nativePost, port, [message, transfer]); };
          if (typeof message === "object" && message !== null && "type" in message && message.type === "arm" && ++probe.arms === 2) { probe.held = true; probe.release = () => { probe.held = false; send(); }; } else send();
        };
      }
    };
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      if (duration === undefined) nativeStart.call(this, when, offset); else nativeStart.call(this, when, offset, duration);
      if (this.context instanceof AudioContext && (window as RepeatWindow).finiteSpeaker?.starts.length === 1) setTimeout(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Repeat track"]')?.click(); }, Math.max(0, when - this.context.currentTime + .03) * 1000);
    };
  });
  await page.goto("/"); await page.getByLabel("Import audio file").setInputFiles({ name: "repeat-boundary.wav", mimeType: "audio/wav", buffer: boundarySource(8001, 129) });
  await expect(page).toHaveURL(/\/master\/track-/u); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as RepeatWindow).repeatProbe?.held)).toBe(true);
  expect(await page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts)).toEqual([expect.objectContaining({ looping: false })]);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "false");
  await page.evaluate(() => { (window as RepeatWindow).repeatProbe?.release?.(); });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts.length)).toBe(1);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  expect(await page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts.length)).toBe(1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts.length)).toBe(2);
  expect(await page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts.at(-1)?.looping)).toBe(true);
  await page.evaluate(() => {
    const probe = (window as RepeatWindow).repeatProbe, button = document.querySelector<HTMLButtonElement>('button[aria-label="Repeat track"]'); if (!probe || !button) throw new Error("Missing Repeat controls");
    button.click(); probe.finiteDeadline = new Float64Array(probe.stream, 8, 2)[1] ?? NaN;
    setTimeout(() => { button.click(); probe.restoredDeadline = new Float64Array(probe.stream, 8, 2)[1] ?? NaN; }, 20);
  });
  await expect.poll(() => page.evaluate(() => (window as RepeatWindow).repeatProbe?.restoredDeadline === Infinity)).toBe(true);
  await page.waitForTimeout(150); await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "true");
  expect(await page.evaluate(() => (window as RepeatWindow).finiteSpeaker?.starts.length)).toBe(2);
  const evidence = await page.evaluate(() => { const probe = (window as RepeatWindow).repeatProbe; return { starts: (window as RepeatWindow).finiteSpeaker?.starts, arms: probe?.arms, finiteDeadline: probe?.finiteDeadline, restoredInfiniteDeadline: probe?.restoredDeadline === Infinity }; });
  expect(evidence.finiteDeadline).toBeLessThan(Infinity); await writeFile(info.outputPath("repeat-intent-evidence.json"), JSON.stringify(evidence, null, 2));
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  const deadline = await page.evaluate(() => { const stream = (window as RepeatWindow).repeatProbe?.stream; if (!stream) throw new Error("Missing source epoch"); return Array.from(new Float64Array(stream, 8, 2)); });
  await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "false");
  const capture = await capturedDevice(page), speaker = await speakerSnapshot(page); if (!capture || !speaker) throw new Error("Missing periodic window capture");
  const validFrames = (deadline[1] ?? 0) - (deadline[0] ?? 0) - Math.ceil(44100 * .08 / 128) * 128;
  const periodic = await finiteDry(page, await project(page), 44100, 0, validFrames, true);
  let dryError = 0; for (let index = 0; index < validFrames; index++) dryError = Math.max(dryError, Math.abs((capture.deviceLeft[index] ?? 0) - (periodic.left[index] ?? 0)), Math.abs((capture.deviceRight[index] ?? 0) - (periodic.right[index] ?? 0)));
  expect(dryError, "A stopped periodic epoch retains its periodic SRC boundary bytes").toBeLessThan(1e-6);
  const first = speaker.left.findIndex(value => value !== 0); expect(first).toBeGreaterThanOrEqual(0); verifySpeakerClock(speaker, 44100, first); expect(speaker.left.length - first).toBeGreaterThanOrEqual(validFrames);
  const latency = exportLatencyFrames(44100);
  let audibleError = 0; for (let index = 0; index < validFrames; index++) audibleError = Math.max(audibleError, Math.abs((speaker.left[first + index] ?? 0) - (capture.outputLeft[latency + index] ?? 0)), Math.abs((speaker.right[first + index] ?? 0) - (capture.outputRight[latency + index] ?? 0)));
  await writeFile(info.outputPath("periodic-speaker-diagnostic.json"), JSON.stringify({ speaker, validFrames, first, deadline, capture, audibleError }));
  expect(audibleError).toBeLessThan(1e-6); expect(speaker.left.slice(first + validFrames).every(value => value === 0)).toBe(true);
  await writeFile(info.outputPath("periodic-window-evidence.json"), JSON.stringify({ validFrames, dryMaximumError: dryError, audibleMaximumError: audibleError, deadline }, null, 2));
});

test("enabling Repeat after finite input EOF drains the whole pass before a clean periodic epoch", async ({ page }, info) => {
  await captureDeepDevice(page, 44100); await observeFiniteSpeaker(page);
  await page.addInitScript(() => {
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      if (duration === undefined) nativeStart.call(this, when, offset); else nativeStart.call(this, when, offset, duration);
      if (this.context instanceof AudioContext && (window as SpeakerWindow).finiteSpeaker?.starts.length === 1) setTimeout(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Repeat track"]')?.click(); }, Math.max(0, when - this.context.currentTime + .03) * 1000);
    };
  });
  await page.goto("/"); await page.getByLabel("Import audio file").setInputFiles({ name: "repeat-drain.wav", mimeType: "audio/wav", buffer: boundarySource(8001, 129) });
  await expect(page).toHaveURL(/\/master\/track-/u); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as SpeakerWindow).finiteSpeaker?.starts.length)).toBe(2);
  const starts = await page.evaluate(() => (window as SpeakerWindow).finiteSpeaker?.starts); if (!starts?.[0] || !starts[1]) throw new Error("Missing repeat epochs");
  expect(starts[0].looping).toBe(false); expect(starts[1].looping).toBe(true); expect(starts[1].offset).toBe(0);
  const gap = starts[1].when - starts[0].when, fullPassAndTail = 129 / 8001 + Math.ceil(44100 * .08 / 128) * 128 / 44100;
  expect(gap).toBeGreaterThanOrEqual(fullPassAndTail);
  await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "true"); await page.getByRole("button", { name: "Pause", exact: true }).click();
  await writeFile(info.outputPath("repeat-drain-evidence.json"), JSON.stringify({ starts, gap, minimumFullPassAndTail: fullPassAndTail }, null, 2));
});
