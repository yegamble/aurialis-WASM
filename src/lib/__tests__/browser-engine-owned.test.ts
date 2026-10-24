import { afterEach, describe, expect, it, vi } from "vitest";
import { serverRenderOwned } from "../browser-engine";
import { deviceOwnedAudioRequest } from "../browser-jobs";
import type { OwnedAudioResult } from "../browser-jobs";
import type { ScriptV2 } from "../deep-mastering";
vi.mock("../browser-jobs", () => ({ deviceAudioRequest: vi.fn(), deviceOwnedAudioRequest: vi.fn(), usesBrowserAudio: () => true }));
const build = "a".repeat(64), layout = { frames: 20, sampleRate: 48000, bitDepth: 24 as const };
afterEach(() => vi.resetAllMocks());
describe("owned engine adapter", () => {
  it("uses the existing owned transport and returns its exact owner after clearing the request fields", async () => {
    let finish: ((result: OwnedAudioResult) => void) | undefined;
    vi.mocked(deviceOwnedAudioRequest).mockReturnValue(new Promise<OwnedAudioResult>((resolve) => { finish = resolve; }));
    const signal = new AbortController().signal, source = new Blob(["source"]), params = { inputGainDb: 2 };
    const pending = serverRenderOwned(source, { params }, layout, signal, build);
    const request = vi.mocked(deviceOwnedAudioRequest).mock.calls[0];
    expect(request?.[0]).toBe("/api/master/render"); expect(request?.[2]).toBe(layout); expect(request?.[3]).toBe(build);
    const form = request?.[1].body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob); expect(form.get("params")).toBe(JSON.stringify(params)); expect(form.get("script")).toBeNull(); expect(form.get("bitDepth")).toBe("24");
    const owner = { update: vi.fn(), dispose: vi.fn() }, output = { blob: new Blob(["encoded"]), owner, dispose: owner.dispose };
    finish?.(output); expect(await pending).toBe(output);
    expect(form.get("file")).toBeNull(); expect(form.get("params")).toBeNull(); expect(owner.update).not.toHaveBeenCalled(); expect(owner.dispose).not.toHaveBeenCalled();
  });
  it("submits the accepted script without a competing static parameter field and clears it on failure", async () => {
    const script = { version: "2.0", moves: [] } as unknown as ScriptV2;
    let form: FormData | undefined;
    vi.mocked(deviceOwnedAudioRequest).mockImplementation((_path, init) => {
      form = init.body as FormData; expect(form.get("script")).toBe(JSON.stringify(script)); expect(form.get("params")).toBeNull();
      return Promise.reject(new Error("Transport denied"));
    });
    await expect(serverRenderOwned(new Blob(), { script }, layout, new AbortController().signal, build)).rejects.toThrow("Transport denied");
    expect(form?.get("file")).toBeNull(); expect(form?.get("script")).toBeNull();
  });
  it("rejects unqualified identity and canceled work before transport admission", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(serverRenderOwned(new Blob(), { params: {} }, layout, controller.signal, build)).rejects.toMatchObject({ name: "AbortError" });
    await expect(serverRenderOwned(new Blob(), { params: {} }, layout, new AbortController().signal, "")).rejects.toMatchObject({ name: "ProcessingBuildMismatchError" });
    expect(deviceOwnedAudioRequest).not.toHaveBeenCalled();
  });
});
