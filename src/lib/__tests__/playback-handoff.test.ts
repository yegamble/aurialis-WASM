import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const intent = { fromTrackId: "source-a", trackId: "source-b", playing: true, volume: 0.37 };
beforeEach(() => {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  vi.spyOn(Date, "now").mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit next-track handoff", () => {
  it("survives a new document once for the expected target, preserving only play intent and volume", async () => {
    const outgoing = await import("../playback-handoff");
    outgoing.stageNextPlaybackHandoff(intent);
    outgoing.reconcileNextPlaybackHandoff("master", "source-a");
    vi.resetModules();
    const incoming = await import("../playback-handoff");
    incoming.reconcileNextPlaybackHandoff("master", "source-b");
    expect(incoming.takeNextPlaybackHandoff("source-b")).toEqual({ playing: true, volume: 0.37 });
    vi.resetModules();
    expect((await import("../playback-handoff")).takeNextPlaybackHandoff("source-b")).toBeNull();
  });

  it("cannot play a wrong target and clears on unrelated navigation or a normal source reload", async () => {
    const handoff = await import("../playback-handoff");
    handoff.stageNextPlaybackHandoff(intent);
    expect(handoff.takeNextPlaybackHandoff("source-c")).toBeNull();
    handoff.reconcileNextPlaybackHandoff("master", "source-c");
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
    handoff.stageNextPlaybackHandoff(intent);
    handoff.reconcileNextPlaybackHandoff("library", "source-a");
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
    handoff.stageNextPlaybackHandoff(intent);
    vi.resetModules();
    const reloaded = await import("../playback-handoff");
    reloaded.reconcileNextPlaybackHandoff("master", "source-a");
    expect(reloaded.takeNextPlaybackHandoff("source-b")).toBeNull();
  });

  it("expires after five seconds and rejects future timestamps or invalid values", async () => {
    const handoff = await import("../playback-handoff");
    handoff.stageNextPlaybackHandoff(intent);
    vi.spyOn(Date, "now").mockReturnValue(15001);
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
    handoff.stageNextPlaybackHandoff(intent);
    vi.spyOn(Date, "now").mockReturnValue(15000);
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
    handoff.stageNextPlaybackHandoff({ ...intent, volume: 2 });
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
  });

  it("falls back safely to memory when session storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new DOMException("Blocked", "SecurityError"); }, setItem: () => { throw new DOMException("Blocked", "SecurityError"); }, removeItem: () => { throw new DOMException("Blocked", "SecurityError"); } });
    const handoff = await import("../playback-handoff");
    expect(() => { handoff.stageNextPlaybackHandoff(intent); }).not.toThrow();
    expect(handoff.takeNextPlaybackHandoff("source-b")).toEqual({ playing: true, volume: 0.37 });
    expect(handoff.takeNextPlaybackHandoff("source-b")).toBeNull();
  });
});
