import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { STEM_MODEL_PLAIN_GO, stemSplitAvailability } from "@/lib/stem-split-copy";
import { StemSplitPanel } from "../StemSplitPanel";

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAudio: () => Promise.resolve(new Blob(["x"])) }));
vi.mock("@/lib/download", () => ({ downloadLocalBlob: mocks.download }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stems = [{ id: "vocals", name: "Vocals", color: "#b4543c" }, { id: "instrumental", name: "Instrumental", color: "#596c52" }];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); mocks.download.mockReset(); });

describe("Smart Split panel", () => {
  it("explains a native server started without the model and disables splitting", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 0 }))));
    render(<StemSplitPanel audioId="a" title="Song" />);
    expect(await screen.findByText("Smart Split is turned off in this Aurialis server: it was started with the separation model disabled.")).toBeTruthy();
    expect(screen.getByText(stemSplitAvailability(false))).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(true);
  });

  it("marks Split unavailable on a plain-Go build, with no estimate", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688, state: "cached", accelerated: false, backend: "portable-go" }))));
    const { container } = render(<StemSplitPanel audioId="a" title="Song" duration={225} />);
    expect(await screen.findByText(STEM_MODEL_PLAIN_GO)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Estimated split time/u);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(true);
  });

  it("says a verified cached model loads on the first split and estimates this song's time", async () => {
    const speed = { windowSeconds: 20, hopSeconds: 10, idleSecondsPerWindow: 32, busySecondsPerWindow: 173 };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688, state: "cached", accelerated: true, backend: "apple-accelerate", speed }))));
    const { container } = render(<StemSplitPanel audioId="a" title="Song" duration={225} />);
    expect(await screen.findByText("The separation model is saved on this computer and verified. The first split loads it; nothing to download.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/downloads the 176 MB/u);
    expect(screen.getByText(/^Estimated split time for this 3:45 song: about 13 minutes/u)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(false);
  });

  it("states browser-build availability once, without a model note or network request", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<StemSplitPanel audioId="a" title="Song" />);
    await act(() => Promise.resolve());
    expect(screen.getByText(stemSplitAvailability(true))).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).not.toMatch(/desktop\s+app|this computer|server/iu);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits into the chosen layout, gives each player its own line on phones and downloads with a named file", async () => {
    const wav = new Blob(["RIFF"], { type: "audio/wav" });
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (input === "/api/stems/model") return Promise.resolve(json({ available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688 }));
      if (input === "/api/separate") {
        expect((init?.body as FormData).get("stems")).toBe("2");
        return Promise.resolve(json({ jobId: "job-9", status: "done", stems }, 202));
      }
      if (input === "/api/jobs/job-9/stems/instrumental") return Promise.resolve(new Response(wav, { headers: { "Content-Disposition": 'attachment; filename="instrumental.wav"' } }));
      return Promise.resolve(json({}));
    }));
    render(<StemSplitPanel audioId="a" title="Song: Take/2" />);
    expect(await screen.findByText("The first split downloads the 176 MB separation model once.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "Split Song: Take/2 into 2 stems" }));
    const list = await screen.findByRole("list", { name: "Separated stems" });
    await waitFor(() => { expect(list.querySelectorAll("li")).toHaveLength(2); });
    const player = screen.getByLabelText("Play Vocals");
    expect(player.getAttribute("src")).toBe("/api/jobs/job-9/stems/vocals");
    expect(player.className.split(" ")).toEqual(expect.arrayContaining(["order-last", "w-full", "md:w-auto"]));
    fireEvent.click(screen.getByRole("button", { name: "Download Instrumental" }));
    await waitFor(() => { expect(mocks.download).toHaveBeenCalledOnce(); });
    const [blob, name] = mocks.download.mock.calls[0] as [Blob, string];
    expect(name).toBe("Song- Take-2 - Instrumental.wav");
    expect(blob.type).toBe("audio/wav");
  });

  it("shows plain-language copy for a failed model download and updates the model note", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (input === "/api/stems/model") return Promise.resolve(json({ available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688 }));
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-4", status: "failed", error: "load separation model: stem model download: 404 Not Found" }, 202));
      if (init?.method === "DELETE") return Promise.resolve(json({}));
      return Promise.resolve(json({}));
    }));
    render(<StemSplitPanel audioId="a" title="Song" />);
    fireEvent.click(await screen.findByRole("button", { name: "Split Song into 4 stems" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The separation model couldn't be downloaded or verified. Check your internet connection, then split again to retry the download.");
    expect(alert.textContent).not.toMatch(/404|load separation model/u);
    expect(await screen.findByText("The 176 MB separation model could not be downloaded or verified. The next split retries the download.")).toBeTruthy();
  });

  it("explains an expired stem instead of failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input === "/api/stems/model") return Promise.resolve(json({ available: true, ready: true, downloading: false, downloadedBytes: 1, totalBytes: 1 }));
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-5", status: "done", stems }, 202));
      if (input.startsWith("/api/jobs/job-5/stems/")) return Promise.resolve(json({ error: "not_found" }, 404));
      return Promise.resolve(json({}));
    }));
    render(<StemSplitPanel audioId="a" title="Song" />);
    fireEvent.click(await screen.findByRole("button", { name: "Split Song into 4 stems" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download Vocals" }));
    expect((await screen.findByRole("alert")).textContent).toBe("These stems are no longer available. Stems are kept for 15 minutes, and restarting the local server clears them. Split the song again.");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("treats a dropped connection as unreachable, keeps checking and re-enables Split when the server is back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let serverUp = true;
      const ready = { available: true, ready: true, downloading: false, downloadedBytes: 1, totalBytes: 1 };
      vi.stubGlobal("fetch", vi.fn((input: string) => {
        if (!serverUp) return Promise.reject(new TypeError("Failed to fetch"));
        if (input === "/api/stems/model") return Promise.resolve(json(ready));
        if (input === "/api/separate") { serverUp = false; return Promise.reject(new TypeError("Failed to fetch")); }
        return Promise.resolve(json({}));
      }));
      render(<StemSplitPanel audioId="a" title="Song" />);
      expect(await screen.findByText("The separation model is ready.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Split Song into 4 stems" }));
      expect((await screen.findByRole("alert")).textContent).toContain("lost contact with its local server");
      const note = screen.getByRole("status");
      await waitFor(() => { expect(note.textContent).toContain("can't reach its local server"); });
      expect(note.textContent).not.toMatch(/disabled|turned off/iu);
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(true);
      serverUp = true;
      await act(() => vi.advanceTimersByTimeAsync(3000));
      await waitFor(() => { expect(note.textContent).toBe("The separation model is ready."); });
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a memory-budget refusal in its own words when saving a stem", async () => {
    mocks.download.mockImplementation(() => { throw new Error("Retained audio exceeds the browser's conservative memory budget."); });
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input === "/api/stems/model") return Promise.resolve(json({ available: true, ready: true, downloading: false, downloadedBytes: 1, totalBytes: 1 }));
      if (input === "/api/separate") return Promise.resolve(json({ jobId: "job-6", status: "done", stems }, 202));
      return Promise.resolve(new Response(new Blob(["RIFF"], { type: "audio/wav" })));
    }));
    render(<StemSplitPanel audioId="a" title="Song" />);
    fireEvent.click(await screen.findByRole("button", { name: "Split Song into 4 stems" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download Vocals" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Retained audio exceeds the browser's conservative memory budget.");
  });
});
