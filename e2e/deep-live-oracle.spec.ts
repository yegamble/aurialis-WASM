import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { engineParams } from "../src/lib/browser-engine";
import type { ScriptV2 } from "../src/lib/deep-mastering";
import type { Track } from "../src/lib/types";
import { observeOutput, outputLevel } from "./live-output";
import { captureDeepDevice, capturedDevice, capturedProgress } from "./deep-capture";
const execute = promisify(execFile);
function shortSource(rate: number, frames: number) {
  const wav = Buffer.alloc(44 + frames * 8); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write("data", 36); wav.writeUInt32LE(frames * 8, 40);
  for (let frame = 0; frame < frames; frame++) { wav.writeFloatLE(.14 * Math.sin(2 * Math.PI * 311 * frame / rate) + .03 * Math.cos(2 * Math.PI * 53 * frame / rate), 44 + frame * 8); wav.writeFloatLE(.09 * Math.sin(2 * Math.PI * 419 * frame / rate + .4), 48 + frame * 8); } return wav;
}
async function current(page: Page): Promise<Track> { const value = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]); if (!value) throw new Error("Missing source"); return value; }
async function expectedDryPrefix(page: Page, track: Track, deviceRate: number, seek: number) {
  return page.evaluate(async ({ key, rate, frame }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const blob = await new Promise<Blob>((resolve, reject) => { const request = db.transaction("audio").objectStore("audio").get(key); request.onsuccess = () => resolve(request.result as Blob); request.onerror = () => reject(request.error); }); db.close();
    const view = new DataView(await blob.arrayBuffer()), sourceRate = view.getUint32(24, true), sourceFrames = view.getUint32(40, true) / 8;
    const context = new OfflineAudioContext(2, 1024, rate), buffer = context.createBuffer(2, sourceFrames, sourceRate);
    for (let index = 0; index < sourceFrames; index++) { buffer.getChannelData(0)[index] = view.getFloat32(44 + index * 8, true); buffer.getChannelData(1)[index] = view.getFloat32(48 + index * 8, true); }
    const node = context.createBufferSource(); node.buffer = buffer; node.loop = true; node.connect(context.destination); node.start(0, frame / sourceRate);
    const result = await context.startRendering(); return { left: Array.from(result.getChannelData(0)), right: Array.from(result.getChannelData(1)) };
  }, { key: track.sourceAudioId ?? track.id, rate: deviceRate, frame: seek });
}
for (const [sourceRate, frames, deviceRate] of [[8001, 129, 44100], [48000, 48001, 48000], [44100, 44101, 96000], [48000, 48001, 192000]] as const) {
  test(`actual delayed source epoch and first mid-play Apply match native PCM at ${sourceRate}→${deviceRate}`, async ({ page }, info) => {
    test.setTimeout(120000); await observeOutput(page); await captureDeepDevice(page, deviceRate, 35);
    await page.goto("/"); await page.getByLabel("Upload audio file").setInputFiles({ name: "clock-source.wav", mimeType: "audio/wav", buffer: shortSource(sourceRate, frames) });
    await expect(page).toHaveURL(/\/master\/track-/u); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
    let compileCount = 0; page.on("request", (request) => { if (request.url().includes("/api/automation/compile")) compileCount++; });
    const original = await current(page); await page.getByRole("tab", { name: "deep", exact: true }).click();
    await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click(); await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
    await page.evaluate((dense) => {
      const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }; const track = state.tracks[0], deep = track?.deepMastering; if (!track?.sourceIdentity || !deep) throw new Error("Missing actual source-bound proposal");
      const identity = track.sourceIdentity;
      deep.proposal.revision++;
      deep.proposal.sections = [{ id: "manual-region", name: "Manual full-source region", roleHint: "unknown", startFrame: 0, endFrame: track.sourceIdentity.frames, confidence: 0 }];
      deep.proposal.moves = [{ id: "manual-gain", sectionId: "manual-region", reason: "Explicit manual gain envelope for a captured-input clock oracle", target: "inputGainDb", operation: "add", fadeFrames: 0, muted: false, points: [{ frame: 0, value: -2 }, { frame: Math.floor(track.sourceIdentity.frames / 2), value: 2 }, { frame: track.sourceIdentity.frames, value: -2 }] }];
      if (dense) {
        const baseline = deep.proposal.chainParams, values = [baseline.inputGainDb, ...baseline.bands.map((band) => band.gainDb), baseline.compressor.thresholdDb, baseline.compressor.ratio, baseline.saturation.amount, baseline.stereo.widthPct];
        deep.proposal.moves = Array.from({ length: 128 }, (_, index) => {
          const target = deep.targets[index % 10]; if (!target) throw new Error("Missing target metadata");
          const base = values[index % 10] ?? 0, radius = target.sampleAccurate ? .4 : target.cellTolerance / 100, direction = base + radius <= target.maximum ? 1 : -1;
          const slot = Math.floor(index / 10), start = Math.floor(identity.frames * slot / 13), end = Math.floor(identity.frames * (slot + 1) / 13);
          return { id: "dense-" + String(index), sectionId: "manual-region", reason: "Explicit maximum-capacity authored envelope fixture", target: target.name, operation: "absolute", fadeFrames: 0, muted: false, points: Array.from({ length: 256 }, (_, point) => ({ frame: start + Math.floor((end - start) * point / 255), value: base + (point > 0 && point < 255 && point % 2 ? direction * radius : 0) })) };
        });
      }
      localStorage.setItem("aurialis-state-v1", JSON.stringify(state));
    }, deviceRate === 192000);
    await page.reload(); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Repeat track", exact: true }).click(); await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await capturedProgress(page))?.frames ?? 0).toBeGreaterThan(4096);
    await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
    await expect(page.getByText(/^Applied revision \d+ acknowledged/u)).toBeVisible({ timeout: 30000 });
    const recovered = page.waitForEvent("download"); await page.getByRole("button", { name: "Download applied Script JSON", exact: true }).click(); const recoveryPath = await (await recovered).path(); if (!recoveryPath) throw new Error("Missing applied recovery snapshot");
    const applied = JSON.parse(await readFile(recoveryPath, "utf8")) as ScriptV2;
    const capturedFrames = deviceRate === 192000 ? 262144 : 65536;
    await expect.poll(async () => (await capturedProgress(page))?.frames ?? 0).toBeGreaterThanOrEqual(capturedFrames);
    expect((await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-70);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const capture = await capturedDevice(page); if (!capture) throw new Error("Missing actual accepted capture");
    expect(capture.missing).toBe(0); expect(capture.deviceRate).toBe(deviceRate);
    if (deviceRate === 192000) { expect(capture.compiledMoves).toBe(128); expect(capture.compiledPoints).toBe(32768); }
    const staticQuanta = capture.versions.findIndex((version) => version > 1); expect(staticQuanta).toBeGreaterThan(0); expect(staticQuanta * 128).toBeLessThan(capturedFrames);
    const prefix = await expectedDryPrefix(page, original, deviceRate, 0);
    const dryError = Math.max(...prefix.left.map((value, index) => Math.abs(value - (capture.deviceLeft[index] ?? 0))), ...prefix.right.map((value, index) => Math.abs(value - (capture.deviceRight[index] ?? 0))));
    expect(dryError, "delayed arm must retain the native source prefix").toBeLessThan(1e-6);
    const inputPath = info.outputPath("captured-input.json"), outputPath = info.outputPath("native-output.json");
    await writeFile(inputPath, JSON.stringify({ sourceRate, frames, deviceRate, seek: 0, looping: true, capturedFrames, staticFrames: staticQuanta * 128, staticParams: engineParams(original.advanced), script: applied, deviceLeft: capture.deviceLeft.slice(0, capturedFrames), deviceRight: capture.deviceRight.slice(0, capturedFrames) }));
    const native = await execute("go", ["test", "./wasm/dsp", "-run", "^TestCapturedDeviceNativeOracle$", "-count=1"], { cwd: process.cwd(), env: { ...process.env, AURIALIS_CAPTURED_INPUT_FIXTURE: inputPath, AURIALIS_CAPTURED_OUTPUT_FIXTURE: outputPath }, timeout: 60000 });
    expect(native.stdout).toContain("ok");
    const expected = JSON.parse(await readFile(outputPath, "utf8")) as { outputLeft: number[]; outputRight: number[]; sourceVerified: boolean };
    expect(expected.sourceVerified).toBe(false); let maximum = 0, squares = 0;
    for (let index = 0; index < capturedFrames; index++) for (const [reference, actual] of [[expected.outputLeft[index], capture.outputLeft[index]], [expected.outputRight[index], capture.outputRight[index]]] as const) { const error = Math.abs((reference ?? 0) - (actual ?? 0)); maximum = Math.max(maximum, error); squares += error * error; }
    const evidence = { sourceRate, frames, deviceRate, delayedArmMs: 35, compiledMoves: capture.compiledMoves, compiledPoints: capture.compiledPoints, authoredMoves: applied.moves.length, authoredPoints: applied.moves.reduce((sum, move) => sum + move.points.length, 0), staticFrames: staticQuanta * 128, capturedFrames, dryPrefixMaximumError: dryError, wetMaximumError: maximum, wetRmsError: Math.sqrt(squares / (capturedFrames * 2)), missedQuanta: capture.missing, appliedRevision: applied.revision };
    await writeFile(info.outputPath("pcm-evidence.json"), JSON.stringify(evidence, null, 2));
    expect(maximum, JSON.stringify(evidence)).toBeLessThan(1e-6);
    const compiledBeforeSeek = compileCount;
    const waveform = page.getByRole("slider", { name: "Track playback position", exact: true }), box = await waveform.boundingBox(); if (!box) throw new Error("Missing seek waveform");
    await waveform.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => { const next = await capturedProgress(page); return next?.generation !== capture.generation && (next?.frames ?? 0) >= 32768; }).toBe(true);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const sought = await capturedDevice(page); if (!sought) throw new Error("Missing sought capture"); expect(sought.missing).toBe(0); expect(sought.seekFrame).toBeGreaterThan(0); expect(sought.seekFrame).toBeLessThan(frames); expect(compileCount).toBe(compiledBeforeSeek);
    const drySeek = await expectedDryPrefix(page, original, deviceRate, sought.seekFrame);
    const seekDryError = Math.max(...drySeek.left.map((value, index) => Math.abs(value - (sought.deviceLeft[index] ?? 0))), ...drySeek.right.map((value, index) => Math.abs(value - (sought.deviceRight[index] ?? 0)))); expect(seekDryError).toBeLessThan(1e-6);
    const seekInput = info.outputPath("seek-captured-input.json"), seekOutput = info.outputPath("seek-native-output.json");
    await writeFile(seekInput, JSON.stringify({ sourceRate, frames, deviceRate, seek: sought.seekFrame, looping: true, capturedFrames: 32768, script: applied, deviceLeft: sought.deviceLeft.slice(0, 32768), deviceRight: sought.deviceRight.slice(0, 32768) }));
    await execute("go", ["test", "./wasm/dsp", "-run", "^TestCapturedDeviceNativeOracle$", "-count=1"], { cwd: process.cwd(), env: { ...process.env, AURIALIS_CAPTURED_INPUT_FIXTURE: seekInput, AURIALIS_CAPTURED_OUTPUT_FIXTURE: seekOutput }, timeout: 60000 });
    const seekReference = JSON.parse(await readFile(seekOutput, "utf8")) as { outputLeft: number[]; outputRight: number[] }; let seekError = 0;
    for (let index = 0; index < 32768; index++) seekError = Math.max(seekError, Math.abs((seekReference.outputLeft[index] ?? 0) - (sought.outputLeft[index] ?? 0)), Math.abs((seekReference.outputRight[index] ?? 0) - (sought.outputRight[index] ?? 0)));
    await writeFile(info.outputPath("seek-pcm-evidence.json"), JSON.stringify({ sourceRate, deviceRate, frames, seekFrame: sought.seekFrame, capturedFrames: 32768, maximumWetError: seekError, maximumDryPrefixError: seekDryError, compileRequestsAfterSeek: compileCount - compiledBeforeSeek }, null, 2));
    expect(seekError).toBeLessThan(1e-6);
  });
}
