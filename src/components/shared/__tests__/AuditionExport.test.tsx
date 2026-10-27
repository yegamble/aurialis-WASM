import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as engine from "@/lib/browser-engine";
import { DEFAULT_DELIVERY, deliveryRequest } from "@/lib/delivery-format";
import { exportRender } from "@/lib/engine-params";
import { testStore } from "@/lib/__tests__/fixtures";
import type { Track } from "@/lib/types";
import { AuditionExport } from "../AuditionExport";

function base(): Track {
  const track = testStore.tracks[0];
  if (!track) throw new Error("Missing fixture");
  return { ...track, sampleRate: 96000, sourceIdentity: { pcmHash: "a".repeat(64), sampleRate: 96000, frames: 96000 } };
}
const wav = new Blob([new Uint8Array(64)], { type: "audio/wav" });
const source = new Blob([new Uint8Array(44 + 96000 * 8)]);
const urls = { create: vi.fn(() => "blob:audition"), revoke: vi.fn() };
let pause: MockInstance<() => void>;

function mount(track = base(), livePlaying = false, onStart = vi.fn()) {
  const view = render(<AuditionExport track={track} sourceBlob={source} delivery={DEFAULT_DELIVERY} livePlaying={livePlaying} onStart={onStart} />);
  const element = () => { const audio = document.querySelector<HTMLAudioElement>("audio.audition-export"); if (!audio) throw new Error("Missing audition element"); return audio; };
  return { ...view, element, onStart };
}

beforeEach(() => {
  urls.create.mockClear(); urls.revoke.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: urls.create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: urls.revoke });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Audition export (V1-10 owner ruling)", () => {
  it("renders the exact Export request and plays that Blob through one media element, holding no decoded buffer", async () => {
    const decoded = vi.fn();
    vi.stubGlobal("AudioContext", vi.fn(() => ({ decodeAudioData: decoded })));
    const delivery = vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: -1.1 });
    const { element, onStart } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(await screen.findByText("Playing the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).")).toBeTruthy();
    // The same arguments Export sends: export render, bit depth and delivery request.
    expect(delivery).toHaveBeenCalledWith(source, exportRender(base()), 24, deliveryRequest(DEFAULT_DELIVERY), expect.any(AbortSignal), expect.any(Function));
    expect(urls.create).toHaveBeenCalledExactlyOnceWith(wav);
    expect(element().getAttribute("src")).toBe("blob:audition");
    expect(onStart).toHaveBeenCalledOnce();
    // Memory: the media element streams the Blob; nothing decodes it into an AudioBuffer.
    expect(AudioContext).not.toHaveBeenCalled();
    expect(decoded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause audition" }));
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
  });

  it("marks the audition stale after an edit, stops it and offers a re-render", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    pause.mockClear();
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} livePlaying={false} onStart={view.onStart} />);
    expect(screen.getByText("Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export.")).toBeTruthy();
    expect(pause).toHaveBeenCalledOnce();
    expect(view.element().getAttribute("src")).toBe("blob:audition");
    expect(screen.queryByRole("button", { name: /Play audition|Pause audition/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Re-render audition" })).toBeTruthy();
  });

  it("cancels a pending render, keeps no audio and releases its memory", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(engine, "renderDelivery").mockImplementation((_file, _render, _bits, _delivery, abort) => new Promise((_resolve, reject) => {
      signal = abort; abort?.addEventListener("abort", () => { reject(new DOMException("Canceled", "AbortError")); });
    }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(screen.getByRole("progressbar", { name: "Audition export render progress" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel audition render" })); await Promise.resolve(); });
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Audition render canceled.")).toBeTruthy();
    expect(urls.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Audition export" })).toBeTruthy();
  });

  it("pauses when live playback starts and revokes its Blob URL on unmount", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} livePlaying onStart={view.onStart} />);
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
    view.unmount();
    expect(urls.revoke).toHaveBeenCalledWith("blob:audition");
  });
});
