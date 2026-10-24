/* Paths belong to the bounded Playwright fixture/artifact scope, never audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
// cspell:words statfs bavail
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, statfs, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AlbumDownloadTransferError, streamAlbumDownload } from "../scripts/qualification/album-download.mjs";
import { expect, type Page, type TestInfo } from "@playwright/test";
export { beforeOwnedWork } from "../scripts/qualification/owned-browser.mjs";
import type { AlbumReport } from "../src/lib/album-batch";

const scaleFrames = 8_640_000, encodedBytes = 51_840_044;
export const canonicalBytes = 69_120_044, totalEncodedBytes = 155_520_132;
const reserveBytes = 6n * 1024n ** 3n, diskGuard = 128n * 1024n ** 2n;
export async function admitDisk(directory: string, demand: number) {
  const values = await statfs(directory, { bigint: true }), available = values.bavail * values.bsize;
  if (available < reserveBytes + diskGuard + BigInt(demand)) throw new Error(`Album qualification stopped before disk allocation: ${String(available)} bytes available, ${String(demand)} bytes requested, 6 GiB reserve plus 128 MiB guard.`);
  return String(available);
}
async function writeAll(file: FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset); if (result.bytesWritten === 0) throw new Error("Scale source write made no progress"); offset += result.bytesWritten; }
}
export async function scaleSource(directory: string, index: number) {
  await mkdir(directory, { recursive: true }); const path = `${directory}/source-${String(index)}.wav`;
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(48000); prefix.writeUInt32LE(2, 4); prefix.writeBigUInt64LE(BigInt(scaleFrames), 8);
  const identity = createHash("sha256").update(prefix), wavHash = createHash("sha256");
  const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(36 + scaleFrames * 4, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(scaleFrames * 4, 40);
  let existing = false; try { existing = (await stat(path)).isFile(); } catch { /* New qualification source. */ }
  if (!existing) await admitDisk(directory, header.length + scaleFrames * 4);
  const file = existing ? null : await open(path, "wx", 0o600); wavHash.update(header);
  try {
    if (file) await writeAll(file, header);
    const chunk = Buffer.alloc(8192 * 4), floats = Buffer.alloc(8192 * 8);
    for (let start = 0; start < scaleFrames; start += 8192) {
      const count = Math.min(8192, scaleFrames - start);
      for (let frame = 0; frame < count; frame++) {
        const at = start + frame, time = at / 48000, envelope = 0.72 + 0.22 * Math.sin(2 * Math.PI * time / 7);
        const left = Math.round(32767 * envelope * (0.17 * Math.sin(2 * Math.PI * (997 + index * 113) * time) + 0.025 * Math.sin(2 * Math.PI * 73 * time)));
        const right = Math.round(32767 * envelope * (0.12 * Math.sin(2 * Math.PI * (1499 + index * 79) * time) + 0.02 * Math.sin(2 * Math.PI * 211 * time)));
        chunk.writeInt16LE(left, frame * 4); chunk.writeInt16LE(right, frame * 4 + 2); floats.writeFloatLE(left / 32768, frame * 8); floats.writeFloatLE(right / 32768, frame * 8 + 4);
      }
      const bytes = chunk.subarray(0, count * 4); wavHash.update(bytes); identity.update(floats.subarray(0, count * 8)); if (file) await writeAll(file, bytes);
    }
  } finally { await file?.close(); }
  const sha256 = wavHash.digest("hex"); if (existing) expect(await hashFile(path)).toBe(sha256);
  return { path, bytes: 44 + scaleFrames * 4, sha256, pcmHash: identity.digest("hex"), sampleRate: 48000, frames: scaleFrames };
}
async function hashFile(path: string) { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) { if (!Buffer.isBuffer(bytes)) throw new Error("Scale file stream returned non-binary data"); hash.update(bytes); } return hash.digest("hex"); }
async function inspect(path: string) {
  const file = await open(path, "r"), hash = createHash("sha256"), header = Buffer.alloc(44); let maximum = 0, frames = 0;
  try {
    expect((await file.read(header, 0, 44, 0)).bytesRead).toBe(44); expect(header.toString("ascii", 0, 4)).toBe("RIFF"); expect(header.readUInt32LE(4) + 8).toBe(encodedBytes); expect(header.toString("ascii", 8, 16)).toBe("WAVEfmt "); expect(header.readUInt32LE(16)).toBe(16); expect(header.readUInt16LE(20)).toBe(1); expect(header.readUInt16LE(22)).toBe(2); expect(header.readUInt32LE(24)).toBe(48000); expect(header.readUInt32LE(28)).toBe(288000); expect(header.readUInt16LE(32)).toBe(6); expect(header.readUInt16LE(34)).toBe(24); expect(header.toString("ascii", 36, 40)).toBe("data"); expect(header.readUInt32LE(40)).toBe(scaleFrames * 6); hash.update(header);
    const chunk = Buffer.alloc(8192 * 6); let position = 44;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position); if (!bytesRead) break; expect(bytesRead % 6).toBe(0); hash.update(chunk.subarray(0, bytesRead));
      for (let offset = 0; offset < bytesRead; offset += 6) maximum = Math.max(maximum, Math.abs(chunk.readIntLE(offset, 3)), Math.abs(chunk.readIntLE(offset + 3, 3)));
      frames += bytesRead / 6; position += bytesRead;
    }
    expect(position).toBe(encodedBytes); expect(frames).toBe(scaleFrames);
  } finally { await file.close(); }
  return { sha256: hash.digest("hex"), frames, bytes: encodedBytes, samplePeakDbfs: 20 * Math.log10(maximum / 8388608) };
}
export async function retainScaleDownload(page: Page, info: TestInfo, row: AlbumReport["tracks"][number], index: number, retain: boolean) {
  // Both the remote server artifact and the bounded client stream occupy physical bytes.
  await admitDisk(info.outputDir, encodedBytes * 2 + 1);
  const control = process.env.AURIALIS_OWNERSHIP_DIR;
  if (!control) throw new Error("Remote Album downloads require their acknowledged scratch owner");
  const clientDirectory = join(dirname(control), "client-downloads"); await mkdir(clientDirectory, { mode: 0o700, recursive: true });
  const unverified = retain ? info.outputPath(`master-${String(index)}.wav`) : join(clientDirectory, `repeat-${String(index)}-${randomUUID()}.unverified.wav`);
  const waiting = page.waitForEvent("download"); await page.getByRole("button", { name: `Download ${row.title}`, exact: true }).click(); const download = await waiting;
  let transfer: Awaited<ReturnType<typeof streamAlbumDownload>> | undefined;
  try {
    transfer = await streamAlbumDownload(download, unverified, encodedBytes);
    const inspected = await inspect(unverified); expect(inspected.sha256).toBe(row.output.sha256); expect(inspected.bytes).toBe(row.output.bytes); expect(inspected.samplePeakDbfs).toBeCloseTo(row.metrics.samplePeakDbfs, 10);
    await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
    const url = await page.evaluate((bytes) => window.albumQA.urls.filter((item) => item.bytes === bytes).at(-1), encodedBytes);
    if (!url || url.revoked === null) throw new Error("Scale output URL cleanup did not settle"); expect(url.revoked - url.created).toBeGreaterThanOrEqual(900);
    const availableDiskBytes = await admitDisk(dirname(info.outputDir), 0);
    await download.delete();
    if (!retain) await unlink(unverified);
    return { ...inspected, retained: retain ? unverified : null, urlLifetimeMs: url.revoked - url.created, availableDiskBytes };
  } catch (cause) {
    const failure = cause instanceof AlbumDownloadTransferError ? cause.receipt : { path: unverified, bytes: transfer?.bytes ?? 0, owned: transfer !== undefined, verified: false };
    const metadata = JSON.stringify({ failure, reason: String(cause).slice(0, 2048), serverArtifactRetention: "The context may remove its own artifact; the bounded client file above is retained when owned." });
    if (Buffer.byteLength(metadata) > 64 * 1024) throw new AggregateError([cause], "Bounded remote Album failure receipt exceeds its limit");
    try { await info.attach(`unverified-download-${String(index)}.json`, { body: metadata, contentType: "application/json" }); }
    catch (publication) { throw new AggregateError([cause, publication], "Remote Album assertion and diagnostic publication failed"); }
    throw cause;
  }
}
export async function memoryProfile(page: Page, value: number) { await page.addInitScript((initial) => { Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => (window as Window & { albumDeviceProfile?: number }).albumDeviceProfile ?? initial }); }, value); }
