/** Synthetic Node/file contracts only; no browser, audio decoder or DSP execution. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs, { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { streamAlbumDownload } from "./qualification/album-download.mjs";
const directories = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function target() { const directory = await mkdtemp(join(tmpdir(), "aurialis-remote-download-unit-")); directories.push(directory); return join(directory, "unverified.wav"); }
function download(chunks, options = {}) {
  const value = { calls: [], path() { throw new Error("Remote path API must never be called"); }, createReadStream() { value.calls.push("stream"); return Promise.resolve(Readable.from(chunks)); }, failure() { value.calls.push("failure"); return Promise.resolve(options.failure ?? null); }, cancel() { value.calls.push("cancel"); return options.cancel?.() ?? Promise.resolve(); } }; return value;
}
test("remote transfer uses the public stream and exact exclusive0600 unverified file", async () => {
  const path = await target(), input = Buffer.from("bounded transfer"), value = download([input.subarray(0, 3), input.subarray(3)]);
  assert.deepEqual(await streamAlbumDownload(value, path, input.length), { path, bytes: input.length, verified: false }); assert.deepEqual(await readFile(path), input); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.deepEqual(value.calls, ["stream", "failure"]);
});
test("an oversized remote transfer retains only E+1 bytes and never returns verified output", async () => {
  const path = await target(), value = download([Buffer.alloc(1024 * 1024, 7)]);
  await assert.rejects(streamAlbumDownload(value, path, 8), (error) => { assert.equal(error.receipt.bytes, 9); assert.equal(error.receipt.received, 1024 * 1024); assert.equal(error.receipt.verified, false); return true; }); assert.equal((await stat(path)).size, 9); assert.equal(value.calls.at(-1), "cancel");
});
test("short and failed remote streams retain bounded partial bytes with the primary failure", async () => {
  for (const errorStream of [false, true]) {
    const path = await target(), value = download([Buffer.from([1, 2, 3])]);
    if (errorStream) value.createReadStream = () => Promise.resolve(Readable.from((async function* () { yield Buffer.from([1, 2, 3]); throw new Error("read failed"); })()));
    await assert.rejects(streamAlbumDownload(value, path, 8), (error) => { assert.equal(error.receipt.bytes, 3); assert.equal(error.receipt.verified, false); assert.match(String(error.cause), errorStream ? /read failed/u : /ended before/u); return true; }); assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]));
  }
});
test("existing output paths are never overwritten or treated as owned", async () => {
  const path = await target(); await writeFile(path, "original"); const value = download([Buffer.alloc(8)]);
  await assert.rejects(streamAlbumDownload(value, path, 8), (error) => { assert.equal(error.cause.code, "EEXIST"); assert.equal(error.receipt.bytes, 0); assert.equal(error.receipt.owned, false); return true; }); assert.equal(await readFile(path, "utf8"), "original"); assert.deepEqual(value.calls, ["cancel"]);
});
test("failed transfer awaits actual cancellation and preserves cancellation failure separately", async () => {
  const path = await target(); let release; const held = new Promise((resolve) => { release = resolve; }), value = download([Buffer.alloc(9)], { cancel: () => held }); let settled = false;
  const pending = streamAlbumDownload(value, path, 8).catch((error) => { settled = true; return error; });
  while (!value.calls.includes("cancel")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(settled, false); assert.equal((await stat(path)).size, 9); release(); const error = await pending; assert.match(String(error.cause), /exceeded/u); assert.equal(error.receipt.bytes, 9);
  const other = await target(), rejected = download([Buffer.alloc(9)], { cancel: () => Promise.reject(new Error("cancel failed")) });
  await assert.rejects(streamAlbumDownload(rejected, other, 8), (failure) => { assert.match(String(failure.cause), /exceeded/u); assert.ok(failure.receipt.cleanup.some((item) => item.includes("cancel failed"))); return true; });
});
test("late download failure retains the complete unverified file instead of publishing it", async () => {
  const path = await target(), value = download([Buffer.alloc(8)], { failure: "browser transfer failed" });
  await assert.rejects(streamAlbumDownload(value, path, 8), (error) => { assert.equal(error.receipt.bytes, 8); assert.equal(error.receipt.verified, false); assert.match(String(error.cause), /browser transfer failed/u); return true; }); assert.equal((await stat(path)).size, 8);
});

test("a missing or rejected remote stream still awaits owned cancellation with its primary intact", async () => {
  for (const missing of [true, false]) {
    const path = await target(); let release; const held = new Promise((resolve) => { release = resolve; }), value = download([], { cancel: () => held });
    value.createReadStream = () => { value.calls.push("stream"); return missing ? Promise.resolve(null) : Promise.reject(new Error("stream acquisition failed")); };
    let settled = false; const pending = streamAlbumDownload(value, path, 8).catch((error) => { settled = true; return error; });
    while (!value.calls.includes("cancel")) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(settled, false); assert.equal((await stat(path)).size, 0); release(); const error = await pending;
    assert.match(String(error.cause), missing ? /did not provide/u : /acquisition failed/u); assert.equal(error.receipt.owned, true); assert.equal(error.receipt.verified, false);
  }
});
test("open collision keeps foreign bytes intact and waits cancellation without claiming that file", async () => {
  const path = await target(); await writeFile(path, "foreign"); let release; const held = new Promise((resolve) => { release = resolve; }), value = download([], { cancel: () => held }); let settled = false;
  const pending = streamAlbumDownload(value, path, 8).catch((error) => { settled = true; return error; });
  while (!value.calls.includes("cancel")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(settled, false); assert.equal(await readFile(path, "utf8"), "foreign"); release(); const error = await pending; assert.equal(error.cause.code, "EEXIST"); assert.equal(error.receipt.owned, false); assert.deepEqual(value.calls, ["cancel"]);
});
test("throwing stream destroy cannot skip cancellation or mask the original download failure", async () => {
  const path = await target(), stream = Readable.from([Buffer.alloc(8)]), destroy = stream.destroy; let calls = 0;
  stream.destroy = function (...args) { if (++calls > 1) throw new Error("destroy cleanup failed"); return destroy.apply(this, args); };
  const value = download([], { failure: "original browser failure" }); value.createReadStream = () => Promise.resolve(stream);
  await assert.rejects(streamAlbumDownload(value, path, 8), (error) => { assert.match(String(error.cause), /original browser failure/u); assert.ok(error.receipt.cleanup.some((entry) => entry.includes("destroy cleanup failed"))); return true; });
  assert.equal(value.calls.at(-1), "cancel"); assert.equal((await stat(path)).size, 8);
});

test("actual partial file writes and held close/cancel settle before failure is returned", async (t) => {
  const path = await target(), originalOpen = fs.open; let writes = 0, closes = 0, releaseClose, releaseCancel;
  const closeHeld = new Promise((resolve) => { releaseClose = resolve; }), cancelHeld = new Promise((resolve) => { releaseCancel = resolve; });
  t.mock.method(fs, "open", async (...args) => { const file = await originalOpen(...args); return {
    write: async (bytes, offset, count) => { if (++writes > 1) throw new Error("actual write rejected"); return file.write(bytes, offset, Math.min(3, count)); },
    close: async () => { closes++; await closeHeld; await file.close(); },
  }; });
  const value = download([Buffer.from("abcdefgh")], { cancel: () => cancelHeld }); let settled = false;
  const pending = streamAlbumDownload(value, path, 8).catch((error) => { settled = true; return error; });
  try {
    const until = Date.now() + 1000; while (!value.calls.includes("cancel") || !closes) { assert.ok(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 1)); }
    assert.equal(settled, false); assert.equal(closes, 1); assert.equal(await readFile(path, "utf8"), "abc"); releaseCancel(); await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(settled, false); releaseClose();
    const error = await pending; assert.match(String(error.cause), /actual write rejected/u); assert.equal(error.receipt.bytes, 3); assert.equal(error.receipt.verified, false); assert.equal((await stat(path)).size, 3);
  } finally { releaseClose(); releaseCancel(); await pending; }
});
test("file-close rejection preserves the primary and secondary cleanup failure while awaiting cancellation", async (t) => {
  const path = await target(), originalOpen = fs.open; let closes = 0, release;
  const held = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "open", async (...args) => { const file = await originalOpen(...args); return {
    write: (...writeArgs) => file.write(...writeArgs),
    close: async () => { closes++; await file.close(); throw new Error(closes === 1 ? "first close acknowledgment failed" : "cleanup close acknowledgment failed"); },
  }; });
  const value = download([Buffer.from("abcdefgh")], { cancel: () => held }); let settled = false;
  const pending = streamAlbumDownload(value, path, 8).catch((error) => { settled = true; return error; });
  try {
    const until = Date.now() + 1000; while (!value.calls.includes("cancel") || closes !== 2) { assert.ok(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 1)); }
    assert.equal(settled, false); assert.equal(await readFile(path, "utf8"), "abcdefgh"); release(); const error = await pending;
    assert.match(String(error.cause), /first close acknowledgment failed/u); assert.ok(error.receipt.cleanup.some((entry) => entry.includes("cleanup close acknowledgment failed"))); assert.equal(error.receipt.bytes, 8); assert.equal(error.receipt.verified, false);
  } finally { release(); await pending; }
});
