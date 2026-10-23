/* Fixed-buffer reader shared by private metadata and Wasm loading.
 * Read counts bound zero/tiny-piece CPU work as well as retained byte storage.
 */
export async function readBoundedResponse(response, { maxBytes, maxReads, check = () => {} }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 4096 || typeof check !== "function")
    throw new Error("Invalid private asset read limits.");
  check();
  if (!response.ok || !response.body) throw new Error("Private decoder asset unavailable.");
  const output = new Uint8Array(maxBytes), reader = response.body.getReader();
  let used = 0, reads = 0;
  try {
    for (;;) {
      check();
      const { done, value } = await reader.read();
      check();
      if (done) break;
      if (++reads > maxReads) throw new Error("Private decoder asset read-count limit exceeded.");
      if (!(value instanceof Uint8Array) || value.byteLength === 0)
        throw new Error("Private decoder asset contains an invalid or empty chunk.");
      if (value.byteLength > maxBytes - used) throw new Error("Private decoder asset exceeds its byte bound.");
      output.set(value, used); used += value.byteLength;
    }
    if (!used) throw new Error("Private decoder asset is empty.");
    return output.subarray(0, used);
  } catch (cause) {
    // A hostile or failed stream must not hold cancellation settlement open.
    try { void reader.cancel().catch(() => {}); } catch { /* Preserve the read failure. */ }
    throw cause;
  } finally {
    try { reader.releaseLock(); } catch { /* No read remains pending here. */ }
  }
}
