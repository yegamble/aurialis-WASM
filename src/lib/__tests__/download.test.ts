import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveBrowserAudioMemory } from "../browser-jobs";

vi.mock("../browser-jobs", () => ({ reserveBrowserAudioMemory: vi.fn() }));
const dispose = vi.fn();
const create = vi.fn();
const revoke = vi.fn();
const click = vi.fn();
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.mocked(reserveBrowserAudioMemory).mockReset().mockReturnValue(Object.freeze({ update: vi.fn(), dispose }));
  dispose.mockReset(); revoke.mockReset(); click.mockReset(); create.mockReset().mockImplementation(() => `blob:local-${String(create.mock.calls.length)}`);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("owned local Blob downloads", () => {
  it("claims before creating a URL and holds one owner until all same-Blob URLs expire", async () => {
    const { downloadLocalBlob } = await import("../download");
    const blob = new Blob(["exact retained WAV"]);
    create.mockImplementation(() => {
      expect(reserveBrowserAudioMemory).toHaveBeenCalledExactlyOnceWith(blob.size);
      expect(dispose).not.toHaveBeenCalled();
      return `blob:local-${String(create.mock.calls.length)}`;
    });
    downloadLocalBlob(blob, "first.wav");
    vi.advanceTimersByTime(500);
    downloadLocalBlob(blob, "second.wav");
    expect(create).toHaveBeenNthCalledWith(1, blob); expect(create).toHaveBeenNthCalledWith(2, blob);
    vi.advanceTimersByTime(500);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:local-1"); expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(revoke).toHaveBeenNthCalledWith(2, "blob:local-2"); expect(dispose).toHaveBeenCalledOnce();
    create.mockImplementation(() => "blob:local-3");
    downloadLocalBlob(blob, "third.wav");
    expect(reserveBrowserAudioMemory).toHaveBeenCalledTimes(2);
    vi.runAllTimers(); expect(dispose).toHaveBeenCalledTimes(2);
  });
  it("rejects allocation before any URL and releases an owner when URL creation fails", async () => {
    const { downloadLocalBlob } = await import("../download");
    vi.mocked(reserveBrowserAudioMemory).mockImplementationOnce(() => { throw new Error("memory budget"); });
    expect(() => { downloadLocalBlob(new Blob(["a"]), "a.wav"); }).toThrow("memory budget");
    expect(create).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
    create.mockImplementationOnce(() => { throw new Error("URL unavailable"); });
    expect(() => { downloadLocalBlob(new Blob(["b"]), "b.wav"); }).toThrow("URL unavailable");
    expect(dispose).toHaveBeenCalledOnce(); expect(revoke).not.toHaveBeenCalled();
  });
  it("revokes failed click URLs immediately without releasing an earlier active download", async () => {
    const { downloadLocalBlob } = await import("../download");
    const blob = new Blob(["retained"]);
    downloadLocalBlob(blob, "first.wav");
    click.mockImplementationOnce(() => { throw new Error("click blocked"); });
    expect(() => { downloadLocalBlob(blob, "second.wav"); }).toThrow("click blocked");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:local-2"); expect(dispose).not.toHaveBeenCalled();
    vi.runAllTimers(); expect(revoke).toHaveBeenNthCalledWith(2, "blob:local-1"); expect(dispose).toHaveBeenCalledOnce();
  });
});
