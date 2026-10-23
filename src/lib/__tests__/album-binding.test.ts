import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlbumRecipeBinding, albumRecordKey, type AlbumTrackRecipe } from "../album-binding";
import { engineParams } from "../engine-params";
import { boundedMetadata, scriptMetadataBytes } from "../script-metadata";
import { deepSettingsSnapshot } from "../deep-mastering";
import { reduceStoreState } from "../store";
import type { ScriptV2 } from "../deep-mastering";
import type { Album, Track } from "../types";
import { testStore } from "./fixtures";

const build = "b".repeat(64);
function fixture(large = false) {
  const base = testStore.tracks[0]; if (!base) throw new Error("Missing track");
  const tracks: Track[] = [0, 1].map((index) => {
    const advanced = structuredClone(base.advanced);
    const source = { pcmHash: String(index + 1).repeat(64), sampleRate: 48000, frames: 48000 };
    const script: ScriptV2 = { version: "2.0", source, revision: 1, profile: "Warm Analog", summary: "Accepted", chainParams: engineParams(advanced),
      sections: [{ id: "all", name: "All", roleHint: "unknown", startFrame: 0, endFrame: 48000, confidence: 0 }],
      moves: Array.from({ length: large ? 128 : 1 }, (_, move) => ({ id: `move-${String(move)}`, sectionId: "all", reason: large ? "r".repeat(2048) : "Measured",
        target: "inputGainDb", operation: "add", points: Array.from({ length: large ? 256 : 2 }, (_, point) => ({ frame: point * 100, value: 0 })), fadeFrames: 0, muted: false })),
      findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 } };
    return { ...base, id: `track-${String(index)}`, title: `Song ${String(index)}`, sampleRate: 48000, duration: 1, sourceIdentity: source, sourceRevision: 2, advanced,
      deepMastering: { sourceRevision: 2, proposal: script, applied: script, targets: [] } };
  });
  const album: Album = { id: "album", title: "Sequence", artist: "Artist", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false, gainMode: "relationships", offsets: {} };
  return { album, tracks };
}
function memory(limit = 128 * 1024 * 1024) {
  const owners: { bytes: number; disposed: boolean }[] = [];
  const reserve = (bytes: number) => {
    if (bytes + owners.reduce((sum, item) => sum + item.bytes, 0) > limit) throw new Error("Metadata memory denied");
    const item = { bytes, disposed: false }; owners.push(item);
    return { update: (next: number) => { if (item.disposed) throw new Error("Disposed"); item.bytes = next; }, dispose: () => { item.bytes = 0; item.disposed = true; } };
  };
  return { owners, reserve, total: () => owners.reduce((sum, item) => sum + item.bytes, 0) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded full Album recipe binding", () => {
  it("checks escaped UTF-8 JSON bounds without calling the serializer and rejects cyclic or executable metadata", () => {
    const value = { string: "\u0000\t\n\"\\é音𝄞\ud800", list: [1, -0, true, false, null, { finite: Number.MAX_VALUE }] };
    const size = new TextEncoder().encode(JSON.stringify(value)).length, stringify = vi.spyOn(JSON, "stringify");
    expect(boundedMetadata(value, size)).toBeGreaterThan(size); expect(() => boundedMetadata(value, size - 1)).toThrow(/metadata/u);
    const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
    expect(() => boundedMetadata(cyclic)).toThrow(/metadata/u); expect(() => boundedMetadata({ toJSON: () => "hidden" })).toThrow(/metadata/u);
    expect(() => boundedMetadata(new ArrayBuffer(4096))).toThrow(/metadata/u); expect(() => boundedMetadata(new Map([["hidden", "value"]]))).toThrow(/metadata/u);
    expect(stringify).not.toHaveBeenCalled();
  });
  it("hashes two large scripts separately before a small ordered digest and preserves immutable records", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { album, tracks } = fixture(true), owners = memory(), binding = new AlbumRecipeBinding(album, tracks, owners.reserve);
    const lengths: number[] = [], stringify = JSON.stringify.bind(JSON);
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => { const encoded = stringify(value); lengths.push(encoded.length); return encoded; });
    const result = await binding.digest(build, new AbortController().signal, () => true);
    expect(result).toMatch(/^[a-f0-9]{64}$/u); expect(binding.album).toBe(album); expect(binding.tracks[0]).toBe(tracks[0]);
    expect(lengths.filter((length) => length > 500_000)).toHaveLength(2); // One recipe per track; validation never serializes a script.
    expect(lengths.at(-1)).toBeLessThan(20_000); expect(Math.max(...lengths)).toBeLessThan(2 * 1024 * 1024 + 16_384);
    expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(1);
    spy.mockRestore(); binding.dispose(); expect(owners.total()).toBe(0);
  });
  it("binds source, static settings, the final authored point, encoding, processing build, titles and order", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { album, tracks } = fixture(), hash = async (nextAlbum: Album, nextTracks: Track[], fingerprint = build) => {
      const binding = new AlbumRecipeBinding(nextAlbum, nextTracks, memory().reserve);
      try { return await binding.digest(fingerprint, new AbortController().signal, () => true); } finally { binding.dispose(); }
    };
    const original = await hash(album, tracks);
    for (const change of [
      (track: Track) => { track.sourceRevision = 3; },
      (track: Track) => { if (track.sourceIdentity) track.sourceIdentity.pcmHash = "f".repeat(64); if (track.deepMastering?.applied && track.sourceIdentity) track.deepMastering.applied.source = track.sourceIdentity; },
      (track: Track) => { track.advanced.input = 1; },
      (track: Track) => { if (track.sourceIdentity) { track.sourceIdentity.frames--; track.duration = track.sourceIdentity.frames / track.sampleRate; } const script = track.deepMastering?.applied; if (script && track.sourceIdentity) { script.source = track.sourceIdentity; const section = script.sections[0]; if (section) section.endFrame--; } },
      (track: Track) => { const point = track.deepMastering?.applied?.moves.at(-1)?.points.at(-1); if (point) point.value = 1; },
      (track: Track) => { track.title = "Renamed"; },
    ]) { const next = structuredClone(tracks); const first = next[0]; if (!first) throw new Error("Missing track"); change(first); expect(await hash(album, next)).not.toBe(original); }
    expect(await hash(album, tracks, "c".repeat(64))).not.toBe(original);
    expect(await hash({ ...album, trackIds: [...album.trackIds].reverse() }, [...tracks].reverse())).not.toBe(original);
    for (const patch of [{ target: "−23 LUFS" }, { artist: "Other" }, { offsets: { "track-0": 1 } }, { mastered: true }, { updatedAt: "2026-10-23" }]) expect(await hash({ ...album, ...patch }, tracks)).not.toBe(original);
    const binding = new AlbumRecipeBinding(album, tracks, memory().reserve);
    const stringify = JSON.stringify.bind(JSON), serialized: string[] = [];
    vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => { const text = stringify(value); if (text) serialized.push(text); return text; });
    await binding.digest(build, new AbortController().signal, () => true);
    expect(serialized.some((text) => text.includes('"encoding":{"version":1,"bits":24,"channels":2,"sampleRate":48000,"frames":48000}'))).toBe(true); binding.dispose();
  });
  it("excludes only report metadata and rejects a different immutable record for same-tab CAS", () => {
    const { album, tracks } = fixture(), before = albumRecordKey(album, tracks);
    expect(albumRecordKey({ ...album, report: {} as NonNullable<Album["report"]> }, tracks)).toBe(before);
    expect(albumRecordKey(album, [{ ...tracks[0] as Track }, ...tracks.slice(1)])).not.toBe(before);
    expect(albumRecordKey({ ...album, mastered: true }, tracks)).not.toBe(before);
  });
  it("holds both referenced metadata and digest copies after cancellation until actual digest settlement", async () => {
    const { album, tracks } = fixture(), owners = memory(), binding = new AlbumRecipeBinding(album, tracks, owners.reserve), controller = new AbortController();
    let resolve: ((value: ArrayBuffer) => void) | undefined;
    const digest = vi.fn().mockImplementation(() => new Promise<ArrayBuffer>((done) => { resolve = done; })); vi.stubGlobal("crypto", { subtle: { digest } });
    const pending = binding.digest(build, controller.signal, () => true), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(digest).toHaveBeenCalledTimes(1); });
    controller.abort(); binding.dispose(); await Promise.resolve();
    expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(2); expect(owners.total()).toBeGreaterThan(32 * 1024 * 1024);
    resolve?.(new ArrayBuffer(32)); await rejected; expect(owners.total()).toBe(0);
  });
  it("rejects a delayed digest after an accepted final-point store edit replaces its immutable Track record", async () => {
    const { album, tracks } = fixture(), first = tracks[0], script = first?.deepMastering?.applied;
    if (!first || !script) throw new Error("Missing script");
    const key = albumRecordKey(album, tracks), owners = memory(), binding = new AlbumRecipeBinding(album, tracks, owners.reserve);
    let state = { tracks, albums: [album], stems: [] };
    let resolve: ((value: ArrayBuffer) => void) | undefined;
    const digest = vi.fn().mockImplementation(() => new Promise<ArrayBuffer>((done) => { resolve = done; })); vi.stubGlobal("crypto", { subtle: { digest } });
    const pending = binding.digest(build, new AbortController().signal, () => albumRecordKey(album, state.tracks) === key);
    const rejected = expect(pending).rejects.toThrow(/changed/u);
    await vi.waitFor(() => { expect(digest).toHaveBeenCalledTimes(1); });
    const changed = { ...script, revision: 2, moves: script.moves.map((move) => ({ ...move, points: move.points.map((point, index) => index === move.points.length - 1 ? { ...point, value: 1 } : point) })) };
    state = reduceStoreState(state, { type: "COMMIT_DEEP_APPLIED", id: first.id, expectedSourceRevision: 2, expectedAudioKey: first.id,
      expectedAppliedRevision: 1, expectedAdvanced: first.advanced, script: changed, advanced: { ...first.advanced }, before: deepSettingsSnapshot(first) });
    expect(state.tracks[0]).not.toBe(first); expect(script.moves[0]?.points.at(-1)?.value).toBe(0);
    expect(state.tracks[0]?.deepMastering?.applied?.moves[0]?.points.at(-1)?.value).toBe(1);
    resolve?.(new ArrayBuffer(32)); await rejected; expect(digest).toHaveBeenCalledTimes(1); expect(owners.total()).toBe(0);
  });
  it("detaches nested modules and keeps the same frozen recipe leased through actual consumer cancellation", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { album, tracks } = fixture(), first = tracks[0], script = first?.deepMastering?.applied;
    if (!first || !script) throw new Error("Missing script");
    const owners = memory(), binding = new AlbumRecipeBinding(album, tracks, owners.reserve), controller = new AbortController();
    await binding.digest(build, controller.signal, () => true);
    let packet: AlbumTrackRecipe | undefined, release: (() => void) | undefined;
    const pending = binding.withTrackRecipe(0, build, controller.signal, () => true, async (value) => {
      packet = value; await new Promise<void>((resolve) => { release = resolve; }); return "settled";
    }), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(packet).toBeDefined(); });
    expect(packet?.script?.chainParams.multiband).not.toBe(script.chainParams.multiband);
    expect(packet?.params.deHarsh).not.toBe(first.advanced.deHarsh); expect(Object.isFrozen(packet?.script?.chainParams.multiband.bands)).toBe(true);
    const threshold = packet?.script?.chainParams.multiband.bands[0]?.thresholdDb, frequency = packet?.params.deHarsh.frequencyHz;
    script.chainParams.multiband.bands[0].thresholdDb += 1; first.advanced.deHarsh.frequencyHz += 25;
    expect(packet?.script?.chainParams.multiband.bands[0]?.thresholdDb).toBe(threshold); expect(packet?.params.deHarsh.frequencyHz).toBe(frequency);
    controller.abort(); binding.dispose(); await Promise.resolve();
    expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(2); release?.(); await rejected; expect(owners.total()).toBe(0);
  });
  it("refuses to render a mutable external recipe changed while an earlier digest was pending", async () => {
    const { album, tracks } = fixture(), first = tracks[0]?.deepMastering?.applied; if (!first) throw new Error("Missing script");
    const owners = memory(), binding = new AlbumRecipeBinding(album, tracks, owners.reserve);
    let release: (() => void) | undefined;
    const actualDigest = (algorithm: string, bytes: Uint8Array<ArrayBuffer>) => webcrypto.subtle.digest(algorithm, bytes);
    const digest = vi.fn(actualDigest).mockImplementationOnce((algorithm: string, bytes: Uint8Array<ArrayBuffer>) => new Promise<ArrayBuffer>((resolve, reject) => {
      release = () => { void actualDigest(algorithm, bytes).then(resolve, reject); };
    })); vi.stubGlobal("crypto", { subtle: { digest } });
    const pending = binding.digest(build, new AbortController().signal, () => true);
    await vi.waitFor(() => { expect(digest).toHaveBeenCalledTimes(1); });
    first.chainParams.multiband.bands[0].thresholdDb += 1; release?.(); await pending;
    const consume = vi.fn().mockResolvedValue(undefined);
    await expect(binding.withTrackRecipe(0, build, new AbortController().signal, () => true, consume)).rejects.toThrow(/recipe changed/u);
    expect(consume).not.toHaveBeenCalled(); expect(owners.total()).toBe(0);
  });
  it("charges a distinct retained proposal, Deep remainder and Album report before admission", () => {
    const { album, tracks } = fixture(true), baseMemory = memory(), base = new AlbumRecipeBinding(album, tracks, baseMemory.reserve);
    const charged = baseMemory.total(); base.dispose();
    const first = tracks[0], deep = first?.deepMastering; if (!first || !deep) throw new Error("Missing script");
    const proposal = structuredClone(deep.proposal); proposal.summary = "A separate unapplied proposal";
    first.deepMastering = { ...deep, proposal };
    const distinctMemory = memory(), distinct = new AlbumRecipeBinding(album, tracks, distinctMemory.reserve);
    expect(distinctMemory.total()).toBe(charged + scriptMetadataBytes(proposal)); const total = distinctMemory.total(); distinct.dispose();
    first.deepMastering = { ...first.deepMastering, before: deepSettingsSnapshot(first) };
    const withBeforeMemory = memory(), withBefore = new AlbumRecipeBinding(album, tracks, withBeforeMemory.reserve);
    expect(withBeforeMemory.total()).toBeGreaterThan(total); withBefore.dispose();
    const report = { metadataOnly: "r".repeat(4096) } as unknown as NonNullable<Album["report"]>;
    const reportMemory = memory(), heldReport = new AlbumRecipeBinding({ ...album, report }, tracks, reportMemory.reserve);
    expect(reportMemory.total()).toBeGreaterThan(total + boundedMetadata(report)); heldReport.dispose();
    const stringify = vi.spyOn(JSON, "stringify");
    expect(() => new AlbumRecipeBinding(album, tracks, memory(charged).reserve)).toThrow(/denied/u); expect(stringify).not.toHaveBeenCalled();
  });
  it("denies oversized or malformed recipes before any serialization, digest or audio allocation", () => {
    const { album, tracks } = fixture(), first = tracks[0]?.deepMastering?.applied; if (!first) throw new Error("Missing script");
    first.moves = Array.from({ length: 129 }, () => first.moves[0] as ScriptV2["moves"][number]);
    const stringify = vi.spyOn(JSON, "stringify"), digest = vi.fn(); vi.stubGlobal("crypto", { subtle: { digest } });
    expect(() => new AlbumRecipeBinding(album, tracks, memory().reserve)).toThrow(/script|metadata/iu); expect(stringify).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled();
    const extra = fixture(), extraScript = extra.tracks[0]?.deepMastering?.applied;
    if (!extraScript) throw new Error("Missing script");
    Object.assign(extraScript, { unexpected: "x".repeat(5000) });
    expect(() => new AlbumRecipeBinding(extra.album, extra.tracks, memory().reserve)).toThrow(/metadata/iu);
    const valid = fixture(), small = memory(1);
    expect(() => new AlbumRecipeBinding(valid.album, valid.tracks, small.reserve)).toThrow(/denied/iu); expect(stringify).not.toHaveBeenCalled();
    const many = fixture(true), repeated = Array.from({ length: 64 }, (_, index) => ({ ...many.tracks[0] as Track, id: `song-${String(index)}` }));
    expect(() => new AlbumRecipeBinding({ ...many.album, trackIds: repeated.map((track) => track.id) }, repeated, memory().reserve)).toThrow(/aggregate|metadata/iu);
  });
});
