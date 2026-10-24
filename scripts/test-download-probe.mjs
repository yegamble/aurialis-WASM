/** Real tiny owned-file inspection only; no browser, audio or service. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { inspectProbeDownload } from "./qualification/download-probe.mjs";
const expected = () => Buffer.from(Array.from({ length: 257 }, (_, index) => (index * 73 + 19) & 255));
async function fixture(run) { const directory = await mkdtemp(join(tmpdir(), "aurialis-probe-unit-")); try { await run(join(directory, "fresh.bin")); } finally { await rm(directory, { recursive: true }); } }
test("the tiny retained probe has exact deterministic bytes and SHA256", () => fixture(async (path) => {
  await writeFile(path, expected(), { flag: "wx", mode: 0o600 }); const result = await inspectProbeDownload(path);
  assert.equal(result.bytes, 257); assert.equal(result.sha256, result.expectedSha256); assert.equal(result.sha256, "dd31e55fd954d9edc9e29f8e078387f0dd38e8ea832376311820de6322cdb0d1"); assert.deepEqual(await readFile(path), expected());
}));
test("short and trailing bytes refuse without deleting the raw probe", () => fixture(async (path) => {
  for (const length of [256, 258]) { await writeFile(path, Buffer.alloc(length), { mode: 0o600 }); await assert.rejects(inspectProbeDownload(path)); assert.equal((await readFile(path)).length, length); }
}));
test("equal-length wrong content cannot pass the probe hash or remove its file", () => fixture(async (path) => {
  const bytes = expected(); bytes[256] ^= 1; await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); await assert.rejects(inspectProbeDownload(path)); assert.deepEqual(await readFile(path), bytes);
}));
