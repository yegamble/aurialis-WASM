import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StemSplitPanel } from "../StemSplitPanel";

vi.mock("@/lib/db", () => ({ getAudio: () => Promise.resolve(new Blob(["x"])) }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Smart Split panel", () => {
  it("disables splitting when the build has no model", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 0 }))));
    render(<StemSplitPanel audioId="a" title="Song" />);
    expect(await screen.findByText("Smart Split is turned off in this build of the app.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Song into 4 stems" }).disabled).toBe(true);
  });

  it("splits into the chosen layout and offers playback and download per stem", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (input === "/api/stems/model") return Promise.resolve(json({ available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688 }));
      if (input === "/api/separate") {
        expect((init?.body as FormData).get("stems")).toBe("2");
        return Promise.resolve(json({ jobId: "job-9", status: "done", stems: [{ id: "vocals", name: "Vocals", color: "#b4543c" }, { id: "instrumental", name: "Instrumental", color: "#596c52" }] }, 202));
      }
      return Promise.resolve(json({}));
    }));
    render(<StemSplitPanel audioId="a" title="Song" />);
    expect(await screen.findByText("The first split downloads the 176 MB separation model once.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "Split Song into 2 stems" }));
    const list = await screen.findByRole("list", { name: "Separated stems" });
    await waitFor(() => { expect(list.querySelectorAll("li")).toHaveLength(2); });
    expect(screen.getByLabelText("Play Vocals").getAttribute("src")).toBe("/api/jobs/job-9/stems/vocals");
    expect(screen.getAllByRole("link", { name: "Download" })[1]?.getAttribute("download")).toBe("Song - Instrumental.wav");
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
});
