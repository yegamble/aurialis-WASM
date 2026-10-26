import { Buffer } from "node:buffer";
import { expect, type Page } from "@playwright/test";
import { fixture } from "./audio-fixture";

/** Deterministic 48 kHz 16-bit stereo drum-and-bass loop at a -1.3 dBFS sample
 * peak (≈ -16 LUFS, ≈ -0.8 dBTP): pitched kick and click, noise snare, stereo
 * noise hats and harmonic bass. Its full-band transients overshoot a sample-peak
 * limiter between samples, which a pure tone never does. Mirrors denseProgram in
 * internal/browserjobs/normalize_test.go; never uses application DSP. */
export function denseFixture(seconds = 8): Buffer {
  const rate = 48000;
  const frames = rate * seconds;
  const left = new Float64Array(frames), right = new Float64Array(frames);
  let seed = 0x9e3779b9;
  const noise = () => {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    return seed / 2147483648 - 1;
  };
  let kickPhase = 0, lastHatL = 0, lastHatR = 0, peak = 0;
  for (let i = 0; i < frames; i += 1) {
    const beat = Math.floor(i / 24000), inBeat = i % 24000, inEighth = i % 12000;
    kickPhase += 2 * Math.PI * (48 + 110 * Math.exp(-inBeat / 480)) / rate;
    const kick = 0.9 * Math.sin(kickPhase) * Math.exp(-inBeat / 7200) + 0.25 * noise() * Math.exp(-inBeat / 96);
    const snare = beat % 2 === 1
      ? 0.55 * noise() * Math.exp(-inBeat / 2400) + 0.3 * Math.sin(2 * Math.PI * 185 * inBeat / rate) * Math.exp(-inBeat / 1400)
      : 0;
    const hatEnvelope = 0.4 * Math.exp(-inEighth / 720);
    const hatL = noise(), hatR = noise();
    const hatOutL = (hatL - lastHatL) * hatEnvelope, hatOutR = (hatR - lastHatR) * hatEnvelope;
    lastHatL = hatL; lastHatR = hatR;
    const at = i / rate;
    const bass = (0.5 * Math.sin(2 * Math.PI * 55 * at) + 0.2 * Math.sin(2 * Math.PI * 110 * at) + 0.1 * Math.sin(2 * Math.PI * 165 * at))
      * (0.95 + 0.15 * Math.exp(-inBeat / 9600));
    const l = kick + snare + 0.8 * hatOutL + 0.3 * hatOutR + bass;
    const r = kick + 0.9 * snare + 0.3 * hatOutL + 0.8 * hatOutR + bass;
    left[i] = l; right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const scale = Math.pow(10, -1.3 / 20) / peak;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 1) {
    wav.writeInt16LE(Math.round((left.at(i) ?? 0) * scale * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round((right.at(i) ?? 0) * scale * 32767), 46 + i * 4);
  }
  return wav;
}

/** Upload a generated source: a 1 kHz tone (default) or the dense program. */
export async function uploadProject(page: Page, name = "qa-workflow.wav", seconds = 1, source: "tone" | "dense" = "tone"): Promise<string> {
  await page.goto("/");
  const buffer = source === "dense" ? denseFixture(seconds) : fixture(1000, seconds);
  await page.getByLabel("Upload audio file").setInputFiles({ name, mimeType: "audio/wav", buffer });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  return new URL(page.url()).pathname.split("/")[2] ?? "";
}
