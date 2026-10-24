/** Metadata-only bounded QA inventory. An overflow can never become a privacy pass. */
const maximumRequests = 1024, maximumBytes = 512 * 1024;
export function scaleNetworkObservation(context) {
  const requests = []; let bytes = 2, failure = null;
  const listener = (request) => {
    if (failure !== null) return;
    try {
      const url = request.url(), method = request.method();
      if (typeof url !== "string" || url.length > 2048 || typeof method !== "string" || method.length > 16 || requests.length >= maximumRequests) throw new Error("Scale network event count or field bound exceeded");
      const record = { url, method, bytes: request.postDataBuffer()?.length ?? 0 }, size = Buffer.byteLength(JSON.stringify(record));
      if (size > 4096 || bytes + size + 1 > maximumBytes) throw new Error("Scale network serialized byte bound exceeded");
      requests.push(record); bytes += size + 1;
    } catch (cause) { failure = String(cause).slice(0, 1024); }
  };
  context.on("request", listener);
  return Object.freeze({ requests,
    assert() { if (failure !== null) throw new Error(failure); },
    close() { context.off("request", listener); },
    serialize(testPassed) {
      const body = JSON.stringify({ complete: testPassed && failure === null, failure, maximumRequests, maximumBytes, requests });
      if (Buffer.byteLength(body) > 544 * 1024) throw new Error("Bounded network publication exceeds its reserved allowance");
      return body;
    }
  });
}
