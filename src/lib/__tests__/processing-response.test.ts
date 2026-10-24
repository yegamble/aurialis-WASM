import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNativeProcessingResponse, ProcessingBuildMismatchError } from "../processing-identity";
import { deviceAudioRequest, deviceOwnedAudioRequest, reserveBrowserAudioMemory } from "../browser-jobs";
import { measureAudio, serverRender } from "../browser-engine";
import { analyzeSourceFeatures } from "../feature-analysis";
const expected = "a".repeat(64), other = "b".repeat(64);
const response = (body: unknown, fingerprint = expected) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Aurialis-Processing-Build": fingerprint } });
const queued = { jobId: "feature-test", status: "queued", progress: 0, stage: "Queued" };
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("response-specific processing authority", () => {
  it("accepts correct native responses without consuming the body and keeps ordinary callers compatible", async () => {
    const valid = response({ status: "ok" }), read = vi.spyOn(valid, "json");
    await assertNativeProcessingResponse(valid, expected); expect(read).not.toHaveBeenCalled(); expect(valid.bodyUsed).toBe(false);
    await assertNativeProcessingResponse(response({}), undefined);
  });
  it.each(["", "development", other])("closes an unqualified or changed native response (%s) before any parsing", async (fingerprint) => {
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    const value = new Response(body, { headers: { "X-Aurialis-Processing-Build": fingerprint } }), read = vi.spyOn(value, "json");
    await expect(assertNativeProcessingResponse(value, expected)).rejects.toBeInstanceOf(ProcessingBuildMismatchError);
    expect(cancel).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  });
  it("retains native binary landing ownership until the mismatched response cancellation settles", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; }), cancel = vi.fn(() => held);
    const value = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "audio/wav", "X-Aurialis-Processing-Build": other } });
    vi.mocked(fetch).mockResolvedValue(value);
    const body = new FormData(); body.append("file", new Blob(["input"])); body.append("bitDepth", "32");
    let settled = false;
    const pending = deviceOwnedAudioRequest("/api/master/render", { method: "POST", body }, { frames: 1, sampleRate: 8000, bitDepth: 32 }, expected).catch((cause: unknown) => { settled = true; return cause; });
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce(); });
    expect(settled).toBe(false); expect(() => reserveBrowserAudioMemory(448 * 1024 * 1024 - 155)).toThrow(/memory/u);
    release?.(); expect(await pending).toBeInstanceOf(ProcessingBuildMismatchError); reserveBrowserAudioMemory(448 * 1024 * 1024).dispose();
  });
  it("rejects invalid expected identities before a request, and catches a host swap on that exact JSON request", async () => {
    await expect(deviceAudioRequest("/api/master/render", { method: "POST" }, undefined, "development")).rejects.toBeInstanceOf(ProcessingBuildMismatchError); expect(fetch).not.toHaveBeenCalled();
    const value = response({ wrongProducer: true }, other), read = vi.spyOn(value, "json"); vi.mocked(fetch).mockResolvedValue(value);
    await expect(deviceAudioRequest("/api/master/render", { method: "POST" }, undefined, expected)).rejects.toBeInstanceOf(ProcessingBuildMismatchError); expect(read).not.toHaveBeenCalled();
  });
  it("does not qualify a native descriptor for browser processing even when its fingerprint matches", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify({ version: 1, target: "native", fingerprint: expected, offlineSha256: other, offlineBytes: 8, realtimeSha256: other, runtimeSha256: other }));
    await expect(deviceAudioRequest("/api/master/render", { method: "POST" }, undefined, expected)).rejects.toBeInstanceOf(ProcessingBuildMismatchError); expect(fetch).not.toHaveBeenCalled();
  });
  it("propagates expected identity through measurement and binary adapters without wrapping a mismatch", async () => {
    for (const operation of [() => measureAudio(new Blob(["input"]), { bypass: true }, new AbortController().signal, expected),
      () => serverRender(new Blob(["input"]), { bypass: true }, 32, new AbortController().signal, expected)]) {
      const value = response({ wrongProducer: true }, other), json = vi.spyOn(value, "json"), blob = vi.spyOn(value, "blob");
      vi.mocked(fetch).mockResolvedValueOnce(value);
      await expect(operation()).rejects.toBeInstanceOf(ProcessingBuildMismatchError); expect(json).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
    }
  });
  it("rejects a build change on the feature job poll before trusting its result and releases the admitted job", async () => {
    const changed = response({ ...queued, status: "done", features: {} }, other), read = vi.spyOn(changed, "json");
    vi.mocked(fetch).mockResolvedValueOnce(response(queued)).mockResolvedValueOnce(changed).mockResolvedValueOnce(response({}));
    await expect(analyzeSourceFeatures(new Blob(["source"]), new AbortController().signal, vi.fn(), expected)).rejects.toBeInstanceOf(ProcessingBuildMismatchError);
    expect(read).not.toHaveBeenCalled(); expect(vi.mocked(fetch).mock.calls[2]?.[1]?.method).toBe("DELETE");
  });
  it("accepts matching native create and poll identities before returning source-bound feature data", async () => {
    const features = { version: "1.0", source: { pcmHash: "c".repeat(64), sampleRate: 48000, frames: 48000 },
      bands: [20, 120, 500, 2000, 6000].map((lowHz, index) => ({ lowHz, highHz: [120, 500, 2000, 6000, 20000].at(index), usableHighHz: [120, 500, 2000, 6000, 20000].at(index), powerDb: -20, valid: true })),
      sections: [{ id: "all", name: "All", startFrame: 0, endFrame: 48000, confidence: 0 }], warnings: [] };
    vi.mocked(fetch).mockResolvedValueOnce(response(queued)).mockResolvedValueOnce(response({ ...queued, status: "done", features })).mockResolvedValueOnce(response({}));
    const result = await analyzeSourceFeatures(new Blob(["source"]), new AbortController().signal, vi.fn(), expected);
    expect(result.source).toEqual(features.source); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("preserves producer mismatch authority when underlying response cancellation rejects", async () => {
    const cause = new Error("Cancellation failed"), cancel = vi.fn().mockRejectedValue(cause);
    const value = new Response(new ReadableStream<Uint8Array>({ cancel }));
    await expect(assertNativeProcessingResponse(value, expected)).rejects.toMatchObject({ name: "ProcessingBuildMismatchError",
      message: "The actual audio response could not confirm this processing build. Refresh the app and try again.", cause });
  });
  it("declines a missing create-response identity without parsing or guessing a job ID", async () => {
    const value = response(queued, ""), read = vi.spyOn(value, "json"); vi.mocked(fetch).mockResolvedValue(value);
    await expect(analyzeSourceFeatures(new Blob(["source"]), new AbortController().signal, vi.fn(), expected)).rejects.toBeInstanceOf(ProcessingBuildMismatchError);
    expect(read).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
});
