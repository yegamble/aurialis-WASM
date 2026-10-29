import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as assembly from "@/lib/album-transitions";
import * as jobs from "@/lib/browser-jobs";
import * as downloads from "@/lib/download";
import { AlbumSequence } from "../AlbumSequence";

vi.mock("@/lib/album-transitions", () => ({ assembleAlbumSequence: vi.fn() }));
vi.mock("@/lib/download", () => ({ downloadLocalBlob: vi.fn() }));
const input = new Blob(["master"]), output = new Blob(["sequence"]);
const create = vi.fn(() => "blob:continuous"), revoke = vi.fn();
const file = { id: "first", title: "First", durable: true, blob: () => Promise.resolve(input) };
function mount(identity = "album:masters") {
  return render(<AlbumSequence identity={identity} title="Album" files={[file]} transition={{ mode: "gapless", seconds: 0 }} onChange={vi.fn()} />);
}
beforeEach(() => {
  vi.mocked(assembly.assembleAlbumSequence).mockReset().mockImplementation((_blobs, _transition, _signal, admit) => { admit(1024); return Promise.resolve(output); });
  create.mockClear(); revoke.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("continuous album ownership", () => {
  it("previews only on user play and downloads exactly the held assembly", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const memory = { update: vi.fn(), dispose: vi.fn() };
    vi.spyOn(jobs, "reserveBrowserAudioMemory").mockReturnValue(memory);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await screen.findByRole("button", { name: "Download continuous WAV" });
    expect(memory.update).toHaveBeenCalledWith(1024);
    expect(memory.dispose).not.toHaveBeenCalled();
    const audio = screen.getByLabelText<HTMLAudioElement>("Continuous album preview");
    expect(audio.getAttribute("preload")).toBe("none"); expect(audio.controls).toBe(true); expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download continuous WAV" }));
    expect(downloads.downloadLocalBlob).toHaveBeenCalledWith(output, "Album - continuous.wav");
    fireEvent.click(screen.getByRole("button", { name: "Discard continuous WAV" }));
    expect(memory.dispose).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith("blob:continuous");
    expect(screen.queryByLabelText("Continuous album preview")).toBeNull();
  });
  it("refuses a disappeared saved master before mixing", async () => {
    render(<AlbumSequence identity="missing" title="Album" files={[{ ...file, blob: () => Promise.resolve(undefined) }]} transition={{ mode: "gapless", seconds: 0 }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await screen.findByText(/saved master for “First” is missing/);
    expect(assembly.assembleAlbumSequence).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("aborts an obsolete identity and ignores an assembly that resolves after cancellation", async () => {
    let resolve: ((blob: Blob) => void) | undefined;
    vi.mocked(assembly.assembleAlbumSequence).mockImplementation(() => new Promise<Blob>((done) => { resolve = done; }));
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await waitFor(() => { expect(assembly.assembleAlbumSequence).toHaveBeenCalledOnce(); });
    const signal = vi.mocked(assembly.assembleAlbumSequence).mock.calls[0]?.[2];
    view.rerender(<AlbumSequence identity="different masters" title="Album" files={[file]} transition={{ mode: "gapless", seconds: 0 }} onChange={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve?.(output); await Promise.resolve(); });
    expect(create).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Download continuous WAV" })).toBeNull();
  });
  it("cancels pending storage reads without creating a sequence", async () => {
    let resolve: ((blob: Blob) => void) | undefined;
    const view = render(<AlbumSequence identity="slow" title="Album" files={[{ ...file, blob: () => new Promise<Blob>((done) => { resolve = done; }) }]} transition={{ mode: "gapless", seconds: 0 }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel continuous album" }));
    await act(async () => { resolve?.(input); await Promise.resolve(); });
    expect(assembly.assembleAlbumSequence).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("cancelled"); view.unmount();
  });
  it("disposes a held preview when transition settings change", async () => {
    const memory = { update: vi.fn(), dispose: vi.fn() }; vi.spyOn(jobs, "reserveBrowserAudioMemory").mockReturnValue(memory);
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await screen.findByRole("button", { name: "Download continuous WAV" });
    view.rerender(<AlbumSequence identity="album:masters" title="Album" files={[file]} transition={{ mode: "gap", seconds: 1 }} onChange={vi.fn()} />);
    expect(memory.dispose).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith("blob:continuous");
    expect(screen.queryByLabelText("Continuous album preview")).toBeNull();
  });
  it("releases admission on failure without exposing an over-budget WAV", async () => {
    const memory = { update: vi.fn((bytes: number) => { if (bytes > input.size) throw new Error("Controlled browser memory budget"); }), dispose: vi.fn() };
    vi.spyOn(jobs, "reserveBrowserAudioMemory").mockReturnValue(memory);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await screen.findByText("Controlled browser memory budget");
    expect(memory.dispose).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Continuous album preview")).toBeNull();
  });
  it("aborts on unmount but keeps pending work charged until it settles", async () => {
    const memory = { update: vi.fn(), dispose: vi.fn() };
    vi.spyOn(jobs, "reserveBrowserAudioMemory").mockReturnValue(memory);
    let resolve: ((blob: Blob) => void) | undefined;
    vi.mocked(assembly.assembleAlbumSequence).mockImplementation((_blobs, _transition, _signal, admit) => { admit(1024); return new Promise<Blob>((done) => { resolve = done; }); });
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Build continuous WAV" }));
    await waitFor(() => { expect(memory.update).toHaveBeenCalledWith(1024); });
    const signal = vi.mocked(assembly.assembleAlbumSequence).mock.calls[0]?.[2];
    view.unmount(); expect(signal?.aborted).toBe(true); expect(memory.dispose).not.toHaveBeenCalled();
    await act(async () => { resolve?.(output); await Promise.resolve(); });
    expect(memory.dispose).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
  });

});
