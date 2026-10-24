/** One tiny no-audio remote Download probe; preserves its fresh client file. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { AlbumDownloadTransferError, streamAlbumDownload } from "./album-download.mjs";

export async function inspectProbeDownload(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), bytes = Buffer.alloc(258);
  try {
    const info = await file.stat(); assert.ok(info.isFile()); assert.equal(info.size, 257); assert.equal(info.mode & 0o777, 0o600);
    let count = 0;
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, count); if (part.bytesRead === 0) break; count += part.bytesRead; }
    assert.equal(count, 257);
    const expected = Buffer.from(Array.from({ length: 257 }, (_, index) => (index * 73 + 19) & 255)), observed = bytes.subarray(0, count);
    assert.deepEqual(observed, expected);
    const sha256 = createHash("sha256").update(observed).digest("hex"), expectedSha256 = "dd31e55fd954d9edc9e29f8e078387f0dd38e8ea832376311820de6322cdb0d1";
    assert.equal(sha256, expectedSha256);
    return { path, bytes: count, sha256, expectedSha256 };
  } finally { await file.close(); }
}

export async function normalDownloadProbe(page, path) {
  // Observe rejection immediately and retain the bounded waiter through settlement.
  const waiting = page.waitForEvent("download", { timeout: 5000 }).then((download) => ({ download }), (error) => ({ error }));
  let url, download, result, primary; const cleanup = [];
  try {
    url = await page.evaluate(() => {
      const bytes = Uint8Array.from({ length: 257 }, (_, index) => (index * 73 + 19) & 255), object = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      try { anchor.href = object; anchor.download = "aurialis-owned-257-byte-probe.bin"; document.body.append(anchor); anchor.click(); return object; }
      catch (error) { URL.revokeObjectURL(object); throw error; }
      finally { anchor.remove(); }
    });
    const outcome = await waiting; if ("error" in outcome) throw outcome.error; download = outcome.download;
    await streamAlbumDownload(download, path, 257);
    result = await inspectProbeDownload(path);
    // Delete the server artifact only after exact geometry/content/hash checks.
    await download.delete();
  } catch (error) { primary = error; }
  finally {
    const outcome = await waiting; download ??= outcome.download;
    if (primary && download && !(primary instanceof AlbumDownloadTransferError)) {
      try { await download.cancel(); } catch (error) { cleanup.push(error); }
    }
    if (url) { try { await page.evaluate((object) => URL.revokeObjectURL(object), url); } catch (error) { cleanup.push(error); } }
  }
  if (primary || cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], "The no-audio remote Download probe failed; any owned client file remains retained");
  return { ...result, retained: true, localBlobOnly: true, audioProcessing: false, serverArtifactDeleted: true, urlRevocationCalled: true };
}
