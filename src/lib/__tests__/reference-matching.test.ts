import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { matchReference } from "../reference-matching";
import { verifyCanonicalSource } from "../project-import";
vi.mock("../project-import", () => ({ verifyCanonicalSource: vi.fn((_blob: Blob, identity: unknown, signal: AbortSignal) => { signal.throwIfAborted(); return Promise.resolve(identity); }) }));
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const expected = { source: identity, reference: { ...identity, pcmHash: "b".repeat(64) } };
const options = { amount: .5, protectBelowHz: 120 as const, includeWidth: false };
const baseline = () => createDefaultAdvancedParams();
function mid(params: ReturnType<typeof engineParams>) { const band = params.bands.at(2); if (!band) throw new Error("Missing test band"); return band; }
function proposal() {
  const params = engineParams(baseline()); mid(params).gainDb = 1;
  return { version: "1.0", sourceSpectrum: "baseline_rendered", source: expected.source, reference: expected.reference, baseline: engineParams(baseline()), params,
    options: { amount: .5, protectBelowHz: 120 },
    bands: [20, 120, 500, 2000, 6000].map((lowHz, i) => ({ lowHz, highHz: [120, 500, 2000, 6000, 20000].at(i), sourceDensityDb: -42, referenceDensityDb: -41, targetDeltaDb: 1, predictedDeltaDb: .9, included: true })),
    beforeOutputResidualDb: 2, afterOutputResidualDb: 1, beforeResidualDb: 1, fitResidualDb: .1, maxPredictedBoostDb: 1.1, maxProtectedDeltaDb: .1, remeasuredProtectedDeltaDb: .1, protectionVerified: true, warnings: ["Five-band estimate"] };
}
function respond(value: unknown) {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "ref-1", kind: "analyze_reference", status: "done", referenceProposal: value }), { status: 202 })).mockResolvedValueOnce(new Response("{}"));
  vi.stubGlobal("fetch", fetch); return fetch;
}
const run = () => matchReference(new Blob(["source"]), new Blob(["reference"]), baseline(), options, expected, new AbortController().signal, vi.fn());
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("measured Reference binding", () => {
  it("submits audio and the exact immutable baseline, accepts only permitted deltas and releases the job", async () => {
    const fetch = respond(proposal()); const result = await run();
    expect(result.advanced.eqBands[2].gainDb).toBe(1);
    expect({ ...result.advanced, eqBands: baseline().eqBands }).toEqual(baseline());
    const call = fetch.mock.calls.at(0); if (!call) throw new Error("Missing admission request");
    const body = (call[1] as RequestInit).body as FormData;
    expect(body.get("source")).toBeInstanceOf(Blob); expect(body.get("reference")).toBeInstanceOf(Blob);
    const encoded = body.get("params"); if (typeof encoded !== "string") throw new Error("Missing submitted parameters");
    expect(JSON.parse(encoded)).toEqual(engineParams(baseline()));
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(verifyCanonicalSource).toHaveBeenCalledTimes(4);
  });
  it.each(["source", "reference"] as const)("rejects a different returned %s identity", async (key) => {
    const value = proposal(); if (key === "source") value.source = { ...value.source, pcmHash: "c".repeat(64) }; else value.reference = { ...value.reference, pcmHash: "c".repeat(64) }; respond(value);
    await expect(run()).rejects.toThrow("stale");
  });
  it("rejects mutated baseline fields, unsupported fields, hidden gain and unchecked width", async () => {
    for (const mutate of [
      (value: ReturnType<typeof proposal>) => { value.baseline.inputGainDb = 3; },
      (value: ReturnType<typeof proposal>) => { value.params.inputGainDb = 3; },
      (value: ReturnType<typeof proposal>) => { mid(value.params).freqHz = 1200; },
      (value: ReturnType<typeof proposal>) => { value.params.stereo.widthPct = 110; },
      (value: ReturnType<typeof proposal>) => { mid(value.params).gainDb = 4; },
      (value: ReturnType<typeof proposal>) => { value.remeasuredProtectedDeltaDb = .3; },
    ]) { const value = proposal(); mutate(value); respond(value); await expect(run()).rejects.toThrow("Invalid"); }
  });
  it("does not start a job for a corrupted loaded source or canceled verification", async () => {
    vi.mocked(verifyCanonicalSource).mockRejectedValueOnce(new Error("PCM differs")); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(run()).rejects.toThrow("PCM differs"); expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(matchReference(new Blob(), new Blob(), baseline(), options, expected, controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
