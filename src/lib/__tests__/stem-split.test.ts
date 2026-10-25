import { afterEach, describe, expect, it, vi } from "vitest";
import { runStemSplit, stemModelStatus } from "../stem-split";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Smart Split client", () => {
  it("reads the local model status and treats the browser build as unavailable", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ available: true, ready: false, downloading: true, downloadedBytes: 5, totalBytes: 10 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await stemModelStatus()).toEqual({ available: true, ready: false, downloading: true, downloadedBytes: 5, totalBytes: 10 });
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    fetchMock.mockClear();
    expect((await stemModelStatus()).available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls past the analysis limit, returns stem URLs and keeps the job until release", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-1", status: "queued", progress: 0, stage: "Queued" }, 202));
      if (init?.method === "DELETE") return Promise.resolve(json({}));
      return Promise.resolve(json({ jobId: "job-1", status: "done", progress: 100, stage: "Complete", stems: [
        { id: "vocals", name: "Vocals", color: "#b4543c" }, { id: "instrumental", name: "Instrumental", color: "#596c52" },
      ] }));
    }));
    const progress: number[] = [];
    const split = await runStemSplit(new Blob(["x"]), 2, new AbortController().signal, (value) => { progress.push(value); });
    expect(split.stems.map((stem) => stem.url)).toEqual(["/api/jobs/job-1/stems/vocals", "/api/jobs/job-1/stems/instrumental"]);
    expect(calls).not.toContain("DELETE /api/jobs/job-1");
    split.release();
    expect(calls).toContain("DELETE /api/jobs/job-1");
    expect(progress).toEqual([0]);
  });

  it("explains unavailable, busy and too-long rejections", async () => {
    for (const [status, detail, message] of [
      [503, "stem separation is not available in this build", "desktop app"],
      [503, "job queue is full", "busy"],
      [413, "audio is too long", "too long"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ detail }, status))));
      await expect(runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined)).rejects.toThrow(message);
    }
  });

  it("deletes the job when a split fails or is cancelled", async () => {
    const deleted: string[] = [];
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted.push(input); return Promise.resolve(json({})); }
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-2", status: "queued", progress: 0, stage: "" }, 202));
      controller.abort();
      return Promise.resolve(json({ jobId: "job-2", status: "running", progress: 40, stage: "Separating stems" }));
    }));
    await expect(runStemSplit(new Blob(["x"]), 4, controller.signal, () => undefined)).rejects.toThrow();
    expect(deleted).toEqual(["/api/jobs/job-2"]);
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted.push(input); return Promise.resolve(json({})); }
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-3", status: "failed", error: "load separation model: checksum mismatch" }, 202));
      return Promise.resolve(json({}));
    }));
    await expect(runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined)).rejects.toThrow("checksum mismatch");
    expect(deleted).toEqual(["/api/jobs/job-2", "/api/jobs/job-3"]);
  });
});
