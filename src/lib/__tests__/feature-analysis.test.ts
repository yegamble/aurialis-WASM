import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSourceFeatures } from "../feature-analysis";

const features = () => ({
  version: "1.0",
  source: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 96000 },
  bands: [20, 120, 500, 2000, 6000].map((lowHz, i) => ({ lowHz, highHz: [120, 500, 2000, 6000, 20000].at(i), usableHighHz: [120, 500, 2000, 6000, 20000].at(i), powerDb: -12, valid: true })),
  sections: [{ id: "section-1", name: "Section 1", startFrame: 0, endFrame: 96000, confidence: 0 }],
  warnings: [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const queued = { jobId: "qa-analysis-1", status: "queued", progress: 0, stage: "Queued" };
afterEach(() => vi.unstubAllGlobals());

describe("measured source analysis jobs", () => {
  it("polls the admitted identity, returns measured summaries and releases retained results", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(queued, 202)).mockResolvedValueOnce(json({ ...queued, status: "done", features: features() })).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const result = await analyzeSourceFeatures(new Blob(["canonical WAV"]), new AbortController().signal, progress);
    expect(result.source.sampleRate).toBe(48000);
    expect(result.sections[0]?.name).toBe("Section 1");
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual(["/api/analyze/features", "/api/jobs/qa-analysis-1?wait=1", "/api/jobs/qa-analysis-1"]);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(progress).toHaveBeenCalledWith(0, "Queued");
  });
  it("does not start a request after cancellation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(analyzeSourceFeatures(new Blob(), controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("receives and deletes an admission racing with Cancel instead of losing its job identity", async () => {
    let accept: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => { accept = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(response).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = analyzeSourceFeatures(new Blob(["audio"]), controller.signal, vi.fn());
    controller.abort();
    accept?.(json(queued, 202));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/jobs/qa-analysis-1");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", keepalive: true });
  });
  it.each(["failed", "cancel" + "led"])("reports %s jobs and releases their reservation", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...queued, status, error: "Analysis could not finish" }, 202)).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetch);
    await expect(analyzeSourceFeatures(new Blob(), new AbortController().signal, vi.fn())).rejects.toThrow("could not finish");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
  it("rejects malformed measured values and invalid interval coverage before displaying results", async () => {
    for (const invalid of [
      { ...features(), source: { ...features().source, pcmHash: "not-a-hash" } },
      { ...features(), sections: [{ id: "bad", name: "Section 1", startFrame: 1, endFrame: 96000, confidence: 0 }] },
      { ...features(), bands: features().bands.map((band) => ({ ...band, powerDb: null })) },
    ]) {
      const fetch = vi.fn().mockResolvedValueOnce(json({ ...queued, status: "done", features: invalid }, 202)).mockResolvedValueOnce(json({}));
      vi.stubGlobal("fetch", fetch);
      await expect(analyzeSourceFeatures(new Blob(), new AbortController().signal, vi.fn())).rejects.toThrow(/Invalid|invalid/u);
      expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    }
  });
  it("reports busy admission without issuing a poll or a guessed deletion", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: "busy" }, 503));
    vi.stubGlobal("fetch", fetch);
    await expect(analyzeSourceFeatures(new Blob(), new AbortController().signal, vi.fn())).rejects.toThrow("busy");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
