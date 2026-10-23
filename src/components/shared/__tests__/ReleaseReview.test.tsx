import "@testing-library/jest-dom/vitest";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAudio } from "@/lib/db";
import { audioKey } from "@/lib/library";
import { collectReleaseReview, releaseBindingHash, type ReleaseReport } from "@/lib/release-review";
import type { OutputBits, ReleasePlatform } from "@/lib/release-policy";
import { StoreProvider, useStore, normalizeHydratedState } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import type { Track } from "@/lib/types";
import { ReleaseReview } from "../ReleaseReview";

const { recordAction, createObjectURL, revokeObjectURL } = vi.hoisted(() => ({
  recordAction: vi.fn<(action: unknown) => void>(),
  createObjectURL: vi.fn((_blob: Blob | MediaSource) => "blob:release-test"),
  revokeObjectURL: vi.fn((_url: string) => undefined),
}));
vi.mock("@/lib/store", async (original) => {
  const actual = await original<typeof import("@/lib/store")>();
  return { ...actual, useStore: () => {
    const context = actual.useStore();
    return { ...context, dispatch: (action: Parameters<typeof context.dispatch>[0]) => {
      recordAction(action); context.dispatch(action);
    } };
  } };
});
vi.mock("@/lib/db", () => ({ getAudio: vi.fn() }));
vi.mock("@/lib/release-review", async (original) => ({
  ...await original<typeof import("@/lib/release-review")>(), collectReleaseReview: vi.fn(),
}));
let current: ReturnType<typeof useStore> | undefined;
function Probe() { current = useStore(); return null; }
function source() { const track = current?.state.tracks[0]; if (!track) throw new Error("Missing source"); return track; }
function dispatch(action: Parameters<ReturnType<typeof useStore>["dispatch"]>[0]) {
  if (!current) throw new Error("Missing store"); current.dispatch(action);
}
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve(value: T) { if (!complete) throw new Error("Missing resolver"); complete(value); } };
}
type ReviewResult = Awaited<ReturnType<typeof collectReleaseReview>>;
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 1 };
const metrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -3, samplePeakDbfs: -3, dynamicRangeDb: 10, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 };
function initial() {
  return { ...structuredClone(testStore), tracks: testStore.tracks.map((track) => ({ ...structuredClone(track), sourceIdentity: identity, sourceRevision: 4, duration: 1 / 48000 })) };
}
async function result(owner: Track, bits: OutputBits, platform: ReleasePlatform = "Spotify", hash = "b".repeat(64)): Promise<ReviewResult> {
  // Opaque controller fixture only; core/native tests establish encoded PCM correctness.
  const wav = new Blob([new Uint8Array(44 + identity.frames * 2 * bits / 8)], { type: "audio/wav" });
  const report: ReleaseReport = { version: 1, createdAt: "2026-10-23T00:00:00Z", title: owner.title, platform,
    bindingHash: await releaseBindingHash(owner, bits, new AbortController().signal), processingHash: "c".repeat(64), scriptRevision: null,
    source: identity, sourceRevision: 4, output: { sampleRate: identity.sampleRate, frames: identity.frames, channels: 2, bitDepth: bits, fullScaleFrames: 0,
      leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60, sha256: hash, bytes: wav.size }, metrics };
  return { report, wav };
}
async function open() {
  const view = render(<StoreProvider><Probe /><ReleaseReview trackId="demo-1" /></StoreProvider>);
  await screen.findByRole("button", { name: "Run release check" });
  return view;
}
async function run() {
  fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
  await screen.findByRole("region", { name: "Encoded audio review" });
}
function download(name: string) {
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name }));
    vi.runOnlyPendingTimers();
  } finally { vi.useRealTimers(); }
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, clear: () => { data.clear(); } });
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  });
  createObjectURL.mockReturnValue("blob:release-test");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  localStorage.setItem("aurialis-state-v1", JSON.stringify(initial()));
  vi.mocked(getAudio).mockResolvedValue(new Blob(["canonical source"]));
  vi.mocked(collectReleaseReview).mockImplementation((_blob, owner, bits, platform) => result(owner, bits, platform));
});
afterEach(() => {
  cleanup(); current = undefined; vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("release review controller", () => {
  it("cancels immediately and rejects an old result after a successful retry", async () => {
    const old = deferred<ReviewResult>(); vi.mocked(collectReleaseReview).mockReturnValueOnce(old.promise);
    await open(); const previous = await result(source(), 24, "Spotify", "d".repeat(64));
    fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
    await waitFor(() => { expect(collectReleaseReview).toHaveBeenCalledTimes(1); });
    const signal = vi.mocked(collectReleaseReview).mock.calls[0]?.[4];
    fireEvent.click(screen.getByRole("button", { name: "Cancel release check" }));
    expect(signal?.aborted).toBe(true); expect(screen.getByRole("button", { name: "Run release check" })).toBeEnabled();
    await run(); expect(collectReleaseReview).toHaveBeenCalledTimes(2);
    await act(async () => { old.resolve(previous); await Promise.resolve(); });
    expect(screen.getByText(`Encoded WAV SHA-256: ${"b".repeat(64)}`)).toBeVisible();
    expect(screen.queryByText(`Encoded WAV SHA-256: ${previous.report.output.sha256}`)).not.toBeInTheDocument();
    expect(source().releaseReview).toBeUndefined();
  });

  it.each(["source", "settings"] as const)("rejects a late result after the %s changes", async (change) => {
    const held = deferred<ReviewResult>(); vi.mocked(collectReleaseReview).mockReturnValueOnce(held.promise);
    await open(); const owner = source(), stale = await result(owner, 24);
    fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
    await waitFor(() => { expect(collectReleaseReview).toHaveBeenCalledOnce(); });
    const signal = vi.mocked(collectReleaseReview).mock.calls[0]?.[4];
    act(() => {
      if (change === "settings") dispatch({ type: "UPDATE_INPUT_GAIN", trackId: owner.id, input: -3 });
      else dispatch({ type: "COMMIT_TRACK_SOURCE", id: owner.id, expectedRevision: 4, expectedAudioKey: audioKey(owner),
        track: { ...owner, sourceAudioId: "replacement-source", sourceRevision: 5, sourceIdentity: { ...identity, pcmHash: "e".repeat(64) } } });
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => { held.resolve(stale); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "Encoded audio review" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run release check" })).toBeEnabled();
    expect(source().releaseReview).toBeUndefined();
    expect(change === "settings" ? source().advanced.input : source().sourceRevision).toBe(change === "settings" ? -3 : 5);
  });

  it("invalidates an in-flight encoding and requires a fresh result for the new bit depth", async () => {
    const held = deferred<ReviewResult>(); vi.mocked(collectReleaseReview).mockReturnValueOnce(held.promise);
    await open(); const stale = await result(source(), 24);
    fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
    await waitFor(() => { expect(collectReleaseReview).toHaveBeenCalledOnce(); });
    const signal = vi.mocked(collectReleaseReview).mock.calls[0]?.[4];
    fireEvent.change(screen.getByRole("combobox", { name: "Review encoding" }), { target: { value: "16" } });
    expect(signal?.aborted).toBe(true);
    await act(async () => { held.resolve(stale); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "Encoded audio review" })).not.toBeInTheDocument();
    await run(); expect(vi.mocked(collectReleaseReview).mock.calls.at(-1)?.[2]).toBe(16);
    expect(screen.getByText("48 kHz · 16-bit PCM · stereo")).toBeVisible();
  });

  it("offers recovery when cached audio is missing and retries without changing mastering settings", async () => {
    vi.mocked(getAudio).mockResolvedValueOnce(undefined);
    await open(); const original = source().advanced;
    fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Restore the matching source in Library");
    expect(collectReleaseReview).not.toHaveBeenCalled(); expect(source().advanced).toBe(original);
    await run(); expect(collectReleaseReview).toHaveBeenCalledOnce(); expect(source().advanced).toBe(original);
  });

  it("aborts on unmount and never saves a result delivered afterward", async () => {
    const held = deferred<ReviewResult>(); vi.mocked(collectReleaseReview).mockReturnValueOnce(held.promise);
    const view = await open(), stale = await result(source(), 24);
    fireEvent.click(screen.getByRole("button", { name: "Run release check" }));
    await waitFor(() => { expect(collectReleaseReview).toHaveBeenCalledOnce(); });
    const signal = vi.mocked(collectReleaseReview).mock.calls[0]?.[4];
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { held.resolve(stale); await Promise.resolve(); });
    const saved: unknown = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}");
    expect(normalizeHydratedState(saved)?.tracks[0]?.releaseReview).toBeUndefined();
  });

  it("downloads the retained Blob without another render and saves to the exact current track", async () => {
    await open(); const owner = source(), measured = await result(owner, 24);
    vi.mocked(collectReleaseReview).mockResolvedValueOnce(measured);
    await run(); download("Download measured WAV"); download("Download measured WAV");
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    for (const call of createObjectURL.mock.calls) expect(call[0]).toBe(measured.wav);
    expect(collectReleaseReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Podcast" }));
    fireEvent.click(screen.getByRole("button", { name: "Save report to project" }));
    await waitFor(() => { expect(source().releaseReview).toMatchObject({ ...measured.report, platform: "Podcast" }); });
    expect(source().advanced).toBe(owner.advanced); expect(collectReleaseReview).toHaveBeenCalledOnce();
  });

  it("restores a saved report without inventing its audio and requires rerun before WAV download", async () => {
    const view = await open(); await run();
    fireEvent.click(screen.getByRole("button", { name: "Save report to project" }));
    await waitFor(() => { expect(source().releaseReview).toBeDefined(); });
    view.unmount(); vi.mocked(collectReleaseReview).mockClear();
    await open();
    expect(await screen.findByText("Saved measurements restored. Run again to restore the measured WAV download.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download measured WAV" })).toBeDisabled();
    download("Download JSON report"); expect(collectReleaseReview).not.toHaveBeenCalled();
    const encoded = createObjectURL.mock.calls[0]?.[0];
    if (!(encoded instanceof Blob)) throw new Error("Missing JSON download");
    const report: unknown = JSON.parse(await encoded.text());
    expect(report).toMatchObject({ measurementBasis: "decoded final encoded WAV", output: { sha256: "b".repeat(64) } });
    const fresh = await result(source(), 24, "Spotify", "f".repeat(64));
    vi.mocked(collectReleaseReview).mockResolvedValueOnce(fresh); await run();
    await waitFor(() => { expect(screen.getByRole("button", { name: "Download measured WAV" })).toBeEnabled(); });
    download("Download measured WAV"); expect(createObjectURL.mock.calls.at(-1)?.[0]).toBe(fresh.wav);
    expect(collectReleaseReview).toHaveBeenCalledOnce();
  });

  it("rejects a Save click batched behind a newer complete track record", async () => {
    await open(); await run(); const owner = source();
    const save = screen.getByRole("button", { name: "Save report to project" });
    act(() => {
      dispatch({ type: "UPDATE_INPUT_GAIN", trackId: owner.id, input: -6 });
      fireEvent.click(save);
    });
    const action = recordAction.mock.calls.map(([item]) => item).find((item) => typeof item === "object" && item !== null && "type" in item && item.type === "SAVE_RELEASE_REVIEW");
    if (typeof action !== "object" || action === null || !("expected" in action)) throw new Error("Missing Save action");
    expect(action.expected).toBe(owner);
    expect(source().advanced.input).toBe(-6); expect(source().releaseReview).toBeUndefined();
    expect(screen.queryByRole("region", { name: "Encoded audio review" })).not.toBeInTheDocument();
  });
});
