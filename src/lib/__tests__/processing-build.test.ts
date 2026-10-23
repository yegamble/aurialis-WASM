import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qualifyProcessingBuild } from "../processing-build";
import { readProcessingIdentity } from "../processing-identity";
const identity = (target: "native" | "browser") => ({ version: 1, target, fingerprint: "a".repeat(64), offlineSha256: "b".repeat(64), offlineBytes: 8, realtimeSha256: "c".repeat(64), runtimeSha256: "d".repeat(64) });
const response = (fingerprint: string) => new Response(JSON.stringify({ processingBuildFingerprint: fingerprint }), { headers: { "Content-Type": "application/json", "X-Aurialis-Processing-Build": "a".repeat(64) } });
const signal = () => new AbortController().signal;
beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser"); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify(identity("browser"))); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("qualified stored processing identity", () => {
  it("accepts only closed versioned bounded identities and freezes the result", () => {
    const encoded = JSON.stringify(identity("browser")), valid = readProcessingIdentity(encoded); expect(valid?.fingerprint).toBe("a".repeat(64)); expect(Object.isFrozen(valid)).toBe(true);
    for (const bad of [undefined, "", "broken", "x".repeat(4097), JSON.stringify({ ...identity("browser"), extra: true }), JSON.stringify({ ...identity("browser"), version: 2 }), JSON.stringify({ ...identity("browser"), offlineSha256: "not-a-hash" })]) expect(readProcessingIdentity(bad)).toBeNull();
  });
  it("qualifies the explicit browser build without any health or localhost request", async () => {
    expect(await qualifyProcessingBuild(signal())).toBe("a".repeat(64)); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing development identities and wrong execution targets without probing", async () => {
    for (const encoded of ["", "development", JSON.stringify(identity("native"))]) { vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", encoded); await expect(qualifyProcessingBuild(signal())).rejects.toThrow(/matching release/u); }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("compares the native linked build only on its explicit loopback path", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify(identity("native")));
    vi.mocked(fetch).mockResolvedValueOnce(response("a".repeat(64)));
    expect(await qualifyProcessingBuild(signal())).toBe("a".repeat(64));
    const request = vi.mocked(fetch).mock.calls[0]; expect(request?.[0]).toBe("/api/health"); expect(request?.[1]?.cache).toBe("no-store"); expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal);
    vi.mocked(fetch).mockResolvedValueOnce(response("")); await expect(qualifyProcessingBuild(signal())).rejects.toThrow(/different processing/u);
  });
  it("never uses a native health probe on a public origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); vi.stubGlobal("location", { hostname: "aurialis.yosefgamble.com" }); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify(identity("native")));
    await expect(qualifyProcessingBuild(signal())).rejects.toThrow(/matching release/u); expect(fetch).not.toHaveBeenCalled();
  });
  it("closes a rejected native health response without consuming its body", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify(identity("native")));
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 503 }));
    await expect(qualifyProcessingBuild(signal())).rejects.toThrow(/confirm its processing build/u); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an oversized native health response and stops reading", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"); vi.stubEnv("NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD", JSON.stringify(identity("native")));
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "application/json", "X-Aurialis-Processing-Build": "a".repeat(64) } }));
    await expect(qualifyProcessingBuild(signal())).rejects.toThrow(/exceeds its limit/u); expect(cancel).toHaveBeenCalledOnce();
  });
  it("declines an already canceled qualification without a request", async () => {
    const canceled = new AbortController(); canceled.abort(); await expect(qualifyProcessingBuild(canceled.signal)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
