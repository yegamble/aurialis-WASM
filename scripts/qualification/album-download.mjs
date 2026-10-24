/** QA-only bounded remote BrowserServer download; never buffers a complete WAV. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { finished } from "node:stream/promises";

export class AlbumDownloadTransferError extends Error {
  constructor(cause, receipt) {
    super(receipt.owned ? "The unverified remote Album file was retained after download failure" : "The remote Album download could not create its owned file", { cause });
    this.receipt = Object.freeze(receipt);
  }
}

export async function streamAlbumDownload(download, path, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 128 * 1024 * 1024) throw new Error("Invalid bounded Album download geometry");
  let file, stream, primary, owned = false, bytes = 0, received = 0;
  const cleanup = [];
  try {
    file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = true;
    stream = await download.createReadStream();
    if (!stream) throw new Error("The remote Album download did not provide a readable stream");
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("The remote Album download returned non-binary data");
      received += chunk.byteLength;
      const available = Math.max(0, expectedBytes + 1 - bytes), accepted = Math.min(available, chunk.byteLength);
      for (let offset = 0; offset < accepted;) {
        const count = Math.min(64 * 1024, accepted - offset), result = await file.write(chunk, offset, count);
        if (result.bytesWritten < 1 || result.bytesWritten > count) throw new Error("The remote Album file write made invalid progress");
        offset += result.bytesWritten; bytes += result.bytesWritten;
      }
      if (bytes > expectedBytes || received > expectedBytes) throw new Error("The remote Album download exceeded its exact encoded byte count");
    }
    if (bytes !== expectedBytes) throw new Error("The remote Album download ended before its exact encoded byte count");
    const failure = await download.failure();
    if (failure !== null) throw new Error("The remote Album download failed: " + String(failure).slice(0, 1024));
    await file.close(); file = undefined;
    return Object.freeze({ path, bytes, verified: false });
  } catch (cause) { primary = cause; }
  let streamSettlement, cancellation;
  if (stream) {
    try { streamSettlement = finished(stream, { cleanup: true }).then(() => undefined, (cause) => cause); }
    catch (cause) { cleanup.push(String(cause).slice(0, 1024)); }
    try { stream.destroy(); } catch (cause) { cleanup.push(String(cause).slice(0, 1024)); }
  }
  // The Download belongs to this handler even when no destination/stream was acquired.
  try { cancellation = Promise.resolve(download.cancel()).catch((cause) => { cleanup.push(String(cause).slice(0, 1024)); }); }
  catch (cause) { cleanup.push(String(cause).slice(0, 1024)); }
  if (file) { try { await file.close(); } catch (cause) { cleanup.push(String(cause).slice(0, 1024)); } }
  await cancellation;
  const streamFailure = await streamSettlement;
  if (streamFailure !== undefined && streamFailure !== primary) cleanup.push(String(streamFailure).slice(0, 1024));
  const receipt = Object.freeze({ path, bytes, received, expectedBytes, owned, verified: false, cleanup: Object.freeze(cleanup) });
  throw new AlbumDownloadTransferError(primary, receipt);
}
