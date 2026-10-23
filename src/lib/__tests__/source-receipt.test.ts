import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { previewWAV } from "../browser-engine";
import { verifyCanonicalSource } from "../project-import";

const identity = { pcmHash: "b091c728c915b19f387a55e0ae9c3b6f69bdda55c17c02775aa414e8dd4208cd", sampleRate: 48000, frames: 1 };
function source(right = 1.25) { return previewWAV({ sampleRate: 48000, left: Float32Array.of(-0), right: Float32Array.of(right) }); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("canonical source verification receipts", () => {
  it("matches the independent LE layout digest with exact headroom and negative-zero bits", async () => {
    vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
    const blob = source(); const before = await blob.arrayBuffer();
    expect(await verifyCanonicalSource(blob, identity, new AbortController().signal)).toEqual(identity);
    expect(await blob.arrayBuffer()).toEqual(before);
  });
  it("rejects replaced PCM despite unchanged track metadata and rejects wrong layout metadata", async () => {
    vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
    await expect(verifyCanonicalSource(source(1.2), identity, new AbortController().signal)).rejects.toThrow("PCM differs");
    await expect(verifyCanonicalSource(source(), { ...identity, frames: 2 }, new AbortController().signal)).rejects.toThrow("PCM differs");
  });
  it("discards a late digest after cancellation and never verifies an aborted load", async () => {
    vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
    let finish: ((value: ArrayBuffer) => void) | undefined;
    const digest = vi.spyOn(webcrypto.subtle, "digest").mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    const controller = new AbortController(); const blob = source(); const pending = verifyCanonicalSource(blob, identity, controller.signal);
    await waitFor(() => { expect(digest).toHaveBeenCalledOnce(); }); controller.abort(); finish?.(Uint8Array.from(identity.pcmHash.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16)).buffer);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(verifyCanonicalSource(source(), identity, controller.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(digest).toHaveBeenCalledOnce();
  });
});
