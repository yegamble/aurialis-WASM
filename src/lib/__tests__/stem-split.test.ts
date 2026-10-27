import { afterEach, describe, expect, it, vi } from "vitest";
import { runStemSplit, stemDownloadName, StemSplitError, stemSplitFailureKind, stemSplitFailureMessage, stemModelStatus } from "../stem-split";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Smart Split client", () => {
  it("reads the local model status and treats the browser build as unavailable", async () => {
    const speed = { windowSeconds: 20, hopSeconds: 10, idleSecondsPerWindow: 32, busySecondsPerWindow: 173 };
    const fetchMock = vi.fn(() => Promise.resolve(json({ available: true, ready: false, downloading: true, downloadedBytes: 5, totalBytes: 10, state: "downloading", accelerated: true, backend: "apple-accelerate", arch: "arm64", speed })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await stemModelStatus()).toEqual({ reachable: true, available: true, ready: false, downloading: true, downloadedBytes: 5, totalBytes: 10, state: "downloading", accelerated: true, backend: "apple-accelerate", arch: "arm64", speed });
    // A plain-Go build: no speed, and an unknown state falls back to the booleans.
    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ available: false, ready: true, state: "bogus", accelerated: false, backend: "portable-go", speed: { windowSeconds: -1 } })));
    expect(await stemModelStatus()).toMatchObject({ available: false, state: "loaded", accelerated: false, backend: "portable-go", arch: "", speed: null });
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    fetchMock.mockClear();
    expect((await stemModelStatus()).available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unanswered or failing local server as unreachable, never as disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await stemModelStatus()).toMatchObject({ reachable: false, available: false });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ error: "internal" }, 500))));
    expect(await stemModelStatus()).toMatchObject({ reachable: false, available: false });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 0 }))));
    expect(await stemModelStatus()).toMatchObject({ reachable: true, available: false });
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

  it("maps each server rejection code to distinct plain-language copy", async () => {
    const seen = new Map<string, string>();
    for (const [status, code, kind] of [
      [503, "stems_unavailable", "unavailable"],
      [503, "busy", "busy"],
      [503, "queue_full", "queue_full"],
      [413, "too_long", "too_long"],
      [413, "payload_too_large", "too_long"],
      [400, "invalid_multipart", "unreadable"],
      [500, "internal", "internal"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ error: code, detail: `raw ${code} detail`, status }, status))));
      const error = await runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined).then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(StemSplitError);
      const failure = error as StemSplitError;
      expect(failure.kind, code).toBe(kind);
      expect(failure.message).not.toContain("raw");
      expect(failure.message).not.toMatch(/desktop\s+app/iu);
      expect(failure.detail).toBe(`raw ${code} detail`);
      seen.set(kind, failure.message);
    }
    // Busy, a full queue and a disabled model each read differently.
    expect(new Set([seen.get("busy"), seen.get("queue_full"), seen.get("unavailable")]).size).toBe(3);
  });

  it("never shows raw Go job errors", async () => {
    for (const [raw, expected] of [
      ["load separation model: stem model download: 404 Not Found", "separation model couldn't be downloaded or verified"],
      ["load separation model: stem model download failed its checksum", "separation model couldn't be downloaded or verified"],
      ['load separation model: Get "https://github.com/x": dial tcp: lookup github.com: no such host', "separation model couldn't be downloaded or verified"],
      ["load separation model: mkdir /Users/a/Library/Caches/Aurialis/models: permission denied", "cache folder"],
      ["load separation model: stem model /c/model.bin is not the expected 176487688-byte file", "cache folder"],
      ["separation job exceeds its 1.5 GiB memory ceiling", "needs more memory"],
      ["source is too long to separate", "too long to split"],
      ["non-finite trained chunk output", "internal error"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => Promise.resolve(init?.method === "DELETE" ? json({}) : json({ jobId: "job-7", status: "failed", error: raw }, 202))));
      const error = await runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined).then(() => null, (failure: unknown) => failure);
      const message = stemSplitFailureMessage(error);
      expect(message).toContain(expected);
      expect(message).not.toContain(raw);
    }
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => Promise.resolve(init?.method === "DELETE" ? json({}) : json({ jobId: "job-8", status: "cancel" + "led" }, 202))));
    await expect(runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined)).rejects.toThrow("90-minute job limit");
    expect(stemSplitFailureMessage(new TypeError("Failed to fetch"))).toContain("lost contact with its local server");
    expect(stemSplitFailureKind(new DOMException("signal timed out", "TimeoutError"))).toBe("timeout");
    expect(stemSplitFailureMessage(new DOMException("signal timed out", "TimeoutError"))).toContain("didn't answer in time");
    expect(stemSplitFailureMessage(new Error("Invalid Smart Split response."))).toContain("internal error");
  });

  it("names stem downloads after the track, safe for every filesystem", () => {
    expect(stemDownloadName("Song", "Vocals")).toBe("Song - Vocals.wav");
    expect(stemDownloadName("../a:b*c?", "Guitar & piano")).toBe("a-b-c- - Guitar & piano.wav");
    expect(stemDownloadName("   ", "Bass")).toBe("Bass.wav");
    expect(stemDownloadName("Song", "../x")).toBe("Song - x.wav");
    expect(stemDownloadName("x".repeat(300), "Drums")).toBe(`${"x".repeat(120)} - Drums.wav`);
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
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-3", status: "failed", error: "load separation model: stem model download failed its checksum" }, 202));
      return Promise.resolve(json({}));
    }));
    await expect(runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined)).rejects.toThrow("separation model couldn't be downloaded or verified");
    expect(deleted).toEqual(["/api/jobs/job-2", "/api/jobs/job-3"]);
  });
});

describe("Smart Split polling", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("treats a vanished job as lost (a server restart), not as the 15-minute expiry", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-11", status: "running", progress: 10, stage: "" }, 202));
      if (init?.method === "DELETE") return Promise.resolve(json({}));
      return Promise.resolve(json({ error: "not_found" }, 404));
    }));
    const error = await runStemSplit(new Blob(["x"]), 4, new AbortController().signal, () => undefined).then(() => null, (failure: unknown) => failure);
    expect(stemSplitFailureKind(error)).toBe("lost");
    expect(stemSplitFailureMessage(error)).toContain("may have restarted");
  });
});
